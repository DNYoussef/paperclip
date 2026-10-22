import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import { authVerifications, type Db } from "@paperclipai/db";

// Credential epoch: one integer row that operator recovery bumps, checked by
// the database at the moment Better Auth writes a session or an account.
//
// Recovery: (1) bump to an odd value and commit ("recovery in progress"),
// (2) replace the user's credentials and delete their sessions, commit,
// (3) compare-and-set to the next even value. Every auth HTTP request reads
// the epoch when it enters, before Better Auth reads any credential. A
// session or account write is refused, and if already written is deleted,
// unless the epoch is even and still equal to that entry value.
//
// So a request that verified a credential before (2) committed cannot keep
// what it writes afterwards: a write committed before (1) is deleted by (2);
// a write checked after (1) sees an odd or a changed epoch. Each check is a
// single committed statement with no session state, so it holds through
// connection loss and transaction-mode pooling, and no server has to stop.
// If the tool dies between (1) and (3) the epoch stays odd and every login is
// refused until the tool runs again (fail closed).
//
// Storage: a fixed row in Better Auth's own verification table (no schema
// change). Its expiry is far in the future so expiry cleanup never removes it.
const EPOCH_ID = "paperclip-credential-epoch";
const FAR_FUTURE = "9999-12-31T00:00:00Z";

type Store = { epoch: number; pendingPassword?: string };
const requestEpoch = new AsyncLocalStorage<Store>();

export async function readCredentialEpoch(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: authVerifications.value })
    .from(authVerifications)
    .where(eq(authVerifications.id, EPOCH_ID));
  return row ? Number(row.value) : 0;
}

// Step (1). Always lands on an odd value, also after an interrupted run.
export async function beginCredentialRecovery(db: Db): Promise<number> {
  const rows = (await db.execute(sql`
    insert into verification (id, identifier, value, expires_at, created_at, updated_at)
    values (${EPOCH_ID}, ${EPOCH_ID}, '1', ${FAR_FUTURE}::timestamptz, now(), now())
    on conflict (id) do update
      set value = (verification.value::bigint + case when verification.value::bigint % 2 = 0 then 1 else 2 end)::text,
          updated_at = now()
    returning value
  `)) as unknown as Array<{ value: string }>;
  return Number(rows[0]!.value);
}

// Step (3). Returns false if another recovery moved the epoch meanwhile; the
// epoch then stays odd until that run ends.
export async function endCredentialRecovery(db: Db, odd: number): Promise<boolean> {
  const rows = await db
    .update(authVerifications)
    .set({ value: String(odd + 1), updatedAt: new Date() })
    .where(sql`${authVerifications.id} = ${EPOCH_ID} and ${authVerifications.value} = ${String(odd)}`)
    .returning();
  return rows.length === 1;
}

// Wrap Better Auth's request handler: every request carries its entry epoch.
export function withEntryEpoch<T>(db: Db, handler: (request: Request) => Promise<T>) {
  return async (request: Request) => {
    const epoch = await readCredentialEpoch(db);
    return requestEpoch.run({ epoch }, () => handler(request));
  };
}

export function rememberPendingPassword(password: unknown) {
  const store = requestEpoch.getStore();
  if (store && typeof password === "string") store.pendingPassword = password;
}

export function pendingPassword() {
  return requestEpoch.getStore()?.pendingPassword;
}

// Throws unless this request may write credentials or sessions now. Writes
// outside a handler request (no entry epoch) are refused.
export async function assertCredentialWriteAllowed(db: Db) {
  const store = requestEpoch.getStore();
  const now = await readCredentialEpoch(db);
  if (!store || now % 2 === 1 || now !== store.epoch) {
    throw new APIError("UNAUTHORIZED", { message: "Credentials changed while signing in; try again" });
  }
}
