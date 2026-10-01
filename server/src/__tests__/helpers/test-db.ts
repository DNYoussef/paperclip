import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import detectPort from "detect-port";
import EmbeddedPostgres from "embedded-postgres";
import { applyPendingMigrations, createDb, ensurePostgresDatabase, type Db } from "@paperclipai/db";

// A real PostgreSQL (embedded-postgres, already a server dependency) with the
// production migrations applied. Authorization predicates live in SQL, so the
// tests that prove them must run that SQL against existing foreign rows.
export interface TestDb {
  db: Db;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-test-pg-"));
  const port = await detectPort(0);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  try {
    await ensurePostgresDatabase(`postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`, "paperclip");
    const url = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(url);
    const db = createDb(url);
    return {
      db,
      stop: async () => {
        await (db as any).$client?.end?.().catch(() => {});
        await pg.stop().catch(() => {});
        removeDir(dir);
      },
    };
  } catch (err) {
    await pg.stop().catch(() => {});
    removeDir(dir);
    throw err;
  }
}

// ponytail: best effort; Windows can hold the data dir briefly after stop.
function removeDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // left for the OS temp cleaner
  }
}
