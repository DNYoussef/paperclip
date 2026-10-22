import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, createDb, instanceUserRoles, type Db } from "@paperclipai/db";
import { beginCredentialRecovery, endCredentialRecovery } from "./credential-epoch.js";

// Operator-only instance-admin recovery. Runs with database access, never over
// HTTP, never opens public sign-up, and is safe while servers keep serving:
// the credential epoch (credential-epoch.ts) makes any login, password
// change or provider link that was in flight lose what it writes. For an existing
// user it deletes every credential (password and linked providers such as
// Google) and every session before setting a fresh password, so whoever held
// the account before (for example an attacker who registered the email while
// sign-up was open) keeps nothing. The user row itself, and so its history
// and company memberships, is kept.
export async function recoverInstanceAdmin(db: Db, rawEmail: string) {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`not an email address: ${JSON.stringify(rawEmail)}`);
  const password = randomBytes(24).toString("base64url");
  const hash = await hashPassword(password);
  const now = new Date();

  const odd = await beginCredentialRecovery(db);
  try {
    return await db.transaction(async (tx) => {
      const users = await tx.select().from(authUsers).where(eq(sql`lower(${authUsers.email})`, email));
      if (users.length > 1) throw new Error(`${users.length} users share ${email}; resolve by hand`);
      let userId = users[0]?.id;
      let removedAccounts = 0;
      let removedSessions = 0;
      if (userId) {
        removedAccounts = (await tx.delete(authAccounts).where(eq(authAccounts.userId, userId)).returning()).length;
        removedSessions = (await tx.delete(authSessions).where(eq(authSessions.userId, userId)).returning()).length;
      } else {
        userId = randomUUID();
        await tx.insert(authUsers).values({
          id: userId,
          name: email.split("@")[0]!,
          email,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx.insert(authAccounts).values({
        id: randomUUID(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: hash,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(instanceUserRoles).values({ userId, role: "instance_admin" }).onConflictDoNothing();
      return { userId, email, password, created: users.length === 0, removedAccounts, removedSessions };
    });
  } finally {
    // Also after a rolled-back transaction (nothing changed). If the process
    // dies before this, logins stay refused until the tool runs again.
    if (!(await endCredentialRecovery(db, odd))) {
      console.error("another recovery moved the credential epoch; logins stay refused until it finishes");
    }
  }
}

// node --import ./server/node_modules/tsx/dist/loader.mjs server/src/auth/recover-admin.ts <email>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const email = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!email || !url) {
    console.error("usage: DATABASE_URL=... recover-admin.ts <email>");
    process.exit(2);
  }
  const db = createDb(url);
  try {
    const r = await recoverInstanceAdmin(db, email);
    console.log(`${r.created ? "Created" : "Recovered"} instance admin ${r.email} (user ${r.userId}).`);
    console.log(`Removed ${r.removedAccounts} credential(s) and ${r.removedSessions} session(s).`);
    console.log(`One-time password: ${r.password}`);
  } catch (err) {
    console.error(`recover-admin failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}
