import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Every running Paperclip server holds a SHARED Postgres advisory lock on this
// key for its whole life. Operator tools that must not race live
// authentication (recover-admin) take the EXCLUSIVE lock in their transaction
// and refuse when they cannot get it, so they only run while no server is
// serving. A server starting during such a tool waits until it commits.
export const SERVING_LEASE_KEY = 7_402_386_411;

type Reserved = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & {
  release: () => void;
};

export async function acquireServingLease(
  db: Db,
  opts: { checkIntervalMs?: number; onLost?: (err: unknown) => void } = {},
) {
  const client = (db as unknown as { $client: { reserve: () => Promise<Reserved> } }).$client;
  const conn = await client.reserve();
  await conn`select pg_advisory_lock_shared(${SERVING_LEASE_KEY})`;
  // ponytail: a dropped lease connection is noticed within checkIntervalMs;
  // the default handler then exits the process so it never serves unleased.
  const onLost =
    opts.onLost ??
    ((err: unknown) => {
      console.error("Paperclip serving lease lost; exiting so no request runs without it", err);
      process.exit(1);
    });
  const timer = setInterval(() => {
    conn`select 1`.catch(onLost);
  }, opts.checkIntervalMs ?? 5_000);
  timer.unref();
  return {
    async release() {
      clearInterval(timer);
      await conn`select pg_advisory_unlock_shared(${SERVING_LEASE_KEY})`;
      conn.release();
    },
  };
}

// For operator tools, inside their transaction; held until commit.
export async function claimExclusiveServingLease(tx: Pick<Db, "execute">) {
  const rows = (await tx.execute(
    sql`select pg_try_advisory_xact_lock(${SERVING_LEASE_KEY}) as ok`,
  )) as unknown as Array<{ ok: boolean }>;
  if (!rows[0]?.ok) {
    throw new Error(
      "a Paperclip server is running against this database (it holds the serving lease); stop every paperclip server, then run this again",
    );
  }
}
