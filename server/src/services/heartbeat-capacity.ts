import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export async function claimQueuedHeartbeatRunForCapacity(input: {
  db: Db;
  run: HeartbeatRunRow;
  claimedAt?: Date;
  maxConcurrentRunsForAgent: (agent: AgentRow) => number;
}) {
  const { db, run, maxConcurrentRunsForAgent } = input;
  if (run.status !== "queued") return run;

  const claimedAt = input.claimedAt ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from agents where id = ${run.agentId} for update`);

    const agent = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, run.agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) return null;

    const maxConcurrentRuns = maxConcurrentRunsForAgent(agent);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running")));
    if (Number(count ?? 0) >= maxConcurrentRuns) return null;

    return tx
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
  });
}
