import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceUserRoles, invites } from "@paperclipai/db";
import { send, startRealApp, type RealApp } from "./helpers/real-app.js";

// A bootstrap_ceo invite grants instance admin exactly once. The claim must
// be atomic with the grant: two concurrent acceptances, or an acceptance
// racing a revocation, may not both promote. Real PostgreSQL; a test
// transaction holds the invite row lock so both requests are provably past
// their initial read before either can write.

let real: RealApp;

beforeAll(async () => {
  real = await startRealApp();
}, 300_000);

afterAll(async () => {
  await real?.stop();
});

async function createBootstrapInvite() {
  const token = `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
  const [row] = await real.db
    .insert(invites)
    .values({
      inviteType: "bootstrap_ceo",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      allowedJoinTypes: "human",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      invitedByUserId: "system",
    })
    .returning();
  return { token, id: row!.id };
}

function accept(token: string, userId: string) {
  return send(real.app, { kind: "board", userId }, "post", `/api/invites/${token}/accept`, { requestType: "human" }).then(
    (res) => res,
  );
}

// Holds FOR UPDATE on the invite row until released; `then` runs inside the
// lock-holding transaction before it commits.
async function lockInvite(id: string) {
  let release!: (then?: (tx: any) => Promise<unknown>) => void;
  const gate = new Promise<((tx: any) => Promise<unknown>) | undefined>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = real.db.transaction(async (tx) => {
    await tx.execute(sql`select id from invites where id = ${id} for update`);
    locked();
    const then = await gate;
    if (then) await then(tx);
  });
  await isLocked;
  return { release, done };
}

async function waitForLockWaiters(n: number) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = (await real.db.execute(
      sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    )) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} lock waiter(s), saw ${rows[0]?.n ?? 0}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function adminsAmong(userIds: string[]) {
  const rows = await real.db.select().from(instanceUserRoles).where(inArray(instanceUserRoles.userId, userIds));
  return rows.filter((r) => r.role === "instance_admin").map((r) => r.userId);
}

describe("bootstrap invite acceptance is atomic", { timeout: 60_000 }, () => {
  it("two concurrent acceptances: exactly one succeeds and exactly one user becomes admin", async () => {
    const { token, id } = await createBootstrapInvite();
    const [u1, u2] = [`racer-a-${randomUUID()}`, `racer-b-${randomUUID()}`];
    const lock = await lockInvite(id);
    const pending = [accept(token, u1), accept(token, u2)];
    await waitForLockWaiters(2);
    lock.release();
    await lock.done;
    const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 404]);
    expect(await adminsAmong([u1, u2])).toHaveLength(1);
  });

  it("an acceptance that read the invite before a revocation committed does not promote", async () => {
    const { token, id } = await createBootstrapInvite();
    const user = `late-${randomUUID()}`;
    const lock = await lockInvite(id);
    const pending = accept(token, user);
    await waitForLockWaiters(1);
    lock.release((tx) =>
      tx.update(invites).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(invites.id, id)),
    );
    await lock.done;
    expect((await pending).status).toBe(404);
    expect(await adminsAmong([user])).toEqual([]);
  });

  it("controls: a single acceptance promotes; a second, sequential one is refused", async () => {
    const { token } = await createBootstrapInvite();
    const [first, second] = [`first-${randomUUID()}`, `second-${randomUUID()}`];
    expect((await accept(token, first)).status).toBe(202);
    expect((await accept(token, second)).status).toBe(404);
    expect(await adminsAmong([first, second])).toEqual([first]);
  });
});
