import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { authAccounts, authSessions, type Db } from "@paperclipai/db";

// Credential epoch: one integer row that operator recovery increments in the
// same transaction that replaces a user's credentials. Every Better Auth
// session or account write is made conditional on it, in its own
// transaction, so a stale write is never committed.
//
// Recovery (one transaction): lock the epoch row FOR UPDATE, delete the
// user's accounts and sessions, insert the fresh credential, grant admin,
// increment the epoch, commit. A second recovery waits on that row lock, so
// recoveries are serialized and each commits completely or not at all.
//
// Request: the wrapped handler reads the epoch on entry, before Better Auth
// reads any credential. A session/account insert or account update then
// runs as: begin; lock the epoch row FOR SHARE (waits for a recovery in
// progress); refuse unless it still equals the entry value; write; commit.
// So a request that verified a credential older than the last committed
// recovery is refused before anything becomes visible, and a recovery that
// starts after such a write took its share lock waits for the write to
// commit and then deletes it. All of it is transaction-scoped: nothing
// depends on a connection staying open or on session-level state, so
// connection loss and transaction-mode pooling do not matter.
//
// Storage: a fixed row in Better Auth's own verification table (no schema
// change); expiry far in the future so expiry cleanup never removes it.
const EPOCH_ID = "paperclip-credential-epoch";
const FAR_FUTURE = "9999-12-31T00:00:00Z";

const requestEpoch = new AsyncLocalStorage<{ epoch: number }>();

type Tx = Pick<Db, "execute">;

async function lockEpoch(tx: Tx, mode: "share" | "update"): Promise<number> {
  await tx.execute(sql`
    insert into verification (id, identifier, value, expires_at, created_at, updated_at)
    values (${EPOCH_ID}, ${EPOCH_ID}, '0', ${FAR_FUTURE}::timestamptz, now(), now())
    on conflict (id) do nothing
  `);
  const rows = (await tx.execute(
    mode === "share"
      ? sql`select value from verification where id = ${EPOCH_ID} for share`
      : sql`select value from verification where id = ${EPOCH_ID} for update`,
  )) as unknown as Array<{ value: string }>;
  return Number(rows[0]!.value);
}

export async function readCredentialEpoch(db: Tx): Promise<number> {
  const rows = (await db.execute(
    sql`select value from verification where id = ${EPOCH_ID}`,
  )) as unknown as Array<{ value: string }>;
  return rows[0] ? Number(rows[0].value) : 0;
}

// For recover-admin: call first inside its transaction; returns a function
// to call last, which increments the epoch.
export async function lockEpochForRecovery(tx: Tx) {
  const epoch = await lockEpoch(tx, "update");
  return async () => {
    await tx.execute(sql`update verification set value = ${String(epoch + 1)}, updated_at = now() where id = ${EPOCH_ID}`);
  };
}

// Wrap Better Auth's request handler: every request carries its entry epoch.
export function withEntryEpoch<T>(db: Db, handler: (request: Request) => Promise<T>) {
  return async (request: Request) => {
    const epoch = await readCredentialEpoch(db);
    return requestEpoch.run({ epoch }, () => handler(request));
  };
}

function refused() {
  return new APIError("UNAUTHORIZED", { message: "Credentials changed while signing in; try again" });
}

async function conditionalWrite<T>(db: Db, write: (tx: Db) => Promise<T>): Promise<T> {
  const store = requestEpoch.getStore();
  // Writes outside a handler request have no entry epoch: refused.
  if (!store) throw refused();
  return db.transaction(async (tx) => {
    if ((await lockEpoch(tx, "share")) !== store.epoch) throw refused();
    return write(tx as unknown as Db);
  });
}

// The database handle given to Better Auth's drizzle adapter. Inserts into
// session and account, and updates of account, go through conditionalWrite;
// everything else passes through. The adapter issues
// insert(table).values(v).returning(), update(table).set(v).where(c).returning()
// and, for updateMany, await update(table).set(v).where(c).
export function withConditionalCredentialWrites(db: Db): Db {
  return new Proxy(db as any, {
    get(target, prop) {
      if (prop === "insert") {
        return (table: unknown) => {
          if (table !== authSessions && table !== authAccounts) return target.insert(table);
          return {
            values: (values: unknown) => ({
              returning: () => conditionalWrite(target, (tx: any) => tx.insert(table).values(values).returning()),
            }),
          };
        };
      }
      if (prop === "update") {
        return (table: unknown) => {
          if (table !== authAccounts) return target.update(table);
          return {
            set: (values: unknown) => ({
              where: (...clause: unknown[]) => {
                const run = (finish: (b: any) => Promise<unknown>) =>
                  conditionalWrite(target, (tx: any) => finish(tx.update(table).set(values).where(...clause)));
                return {
                  then: (ok: any, bad: any) => run(async (b) => b).then(ok, bad),
                  returning: () => run((b) => b.returning()),
                };
              },
            }),
          };
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}
