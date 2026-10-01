import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueComments } from "@paperclipai/db";
import { agentService, costService, heartbeatService } from "../services/index.js";
import { seedWorld, startRealApp, type RealApp, type World } from "./helpers/real-app.js";

// SEC-060 run lifecycle against the real heartbeat service and PostgreSQL.
// The adapter is a probe (records launches, never spawns a process), and a
// hook runs inside workspace-runtime setup: after the run started and the
// agent was marked running, before the adapter would launch. Each test drives
// one real lifecycle operation into that gap.

const probe = vi.hoisted(() => ({
  launches: [] as string[],
  duringSetup: null as null | (() => Promise<void>),
  duringExecute: null as null | (() => Promise<void>),
}));

vi.mock("../adapters/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../adapters/index.js")>();
  return {
    ...mod,
    getServerAdapter: (type: string) => ({
      ...mod.getServerAdapter(type),
      supportsLocalAgentJwt: false,
      execute: async (input: { runId: string }) => {
        probe.launches.push(input.runId);
        const hook = probe.duringExecute;
        probe.duringExecute = null;
        if (hook) await hook();
        return { exitCode: 0, signal: null, timedOut: false };
      },
    }),
  };
});

vi.mock("../services/workspace-runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/workspace-runtime.js")>();
  return {
    ...mod,
    ensureRuntimeServicesForRun: async (...args: Parameters<typeof mod.ensureRuntimeServicesForRun>) => {
      const hook = probe.duringSetup;
      probe.duringSetup = null;
      if (hook) await hook();
      return mod.ensureRuntimeServicesForRun(...args);
    },
  };
});

let real: RealApp;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "paperclip-test-home-"));
  process.env.PAPERCLIP_HOME = home;
  process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
  real = await startRealApp();
}, 120_000);

afterAll(async () => {
  await real?.stop();
});

beforeEach(() => {
  probe.launches = [];
  probe.duringSetup = null;
  probe.duringExecute = null;
});

const db = () => real.db;
const statusOf = (agentId: string) =>
  db().select({ status: agents.status }).from(agents).where(eq(agents.id, agentId)).then((r) => r[0]!.status);
// The run row is finalized before the agent row, so a live agent's final
// status is awaited rather than read once.
const settlesTo = (agentId: string, status: string) =>
  vi.waitFor(async () => expect(await statusOf(agentId)).toBe(status), { timeout: 5_000, interval: 50 });

async function freshWorker(w: World, extra: Partial<typeof agents.$inferInsert> = {}) {
  return db()
    .insert(agents)
    .values({ companyId: w.companyA.id, name: `worker ${Math.random().toString(36).slice(2, 8)}`, status: "idle", ...extra })
    .returning()
    .then((r) => r[0]!);
}

async function wakeAndSettle(agentId: string, opts: Record<string, unknown> = {}) {
  const heartbeat = heartbeatService(db());
  const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", ...opts } as any);
  if (!run) return null;
  await vi.waitFor(
    async () => {
      const row = await db().select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
      expect(["queued", "running"]).not.toContain(row.status);
    },
    { timeout: 10_000, interval: 50 },
  );
  return db().select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
}

describe("run startup is abandoned when the agent or run stops being runnable (SEC-060)", () => {
  it("control: a live agent's run launches the adapter and finishes", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    const run = await wakeAndSettle(worker.id);
    expect(run?.status).toBe("succeeded");
    expect(probe.launches).toEqual([run!.id]);
    await settlesTo(worker.id, "idle");
  });

  it("termination during setup: no adapter launch, status stays terminated", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    probe.duringSetup = async () => {
      await agentService(db()).terminate(worker.id);
    };
    const run = await wakeAndSettle(worker.id);
    expect(probe.duringSetup).toBeNull();
    expect(probe.launches).toEqual([]);
    expect(run?.status).toBe("cancelled");
    expect(await statusOf(worker.id)).toBe("terminated");
  });

  it("budget auto-pause during setup: no adapter launch, status stays paused", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w, { budgetMonthlyCents: 100 });
    probe.duringSetup = async () => {
      await costService(db()).createEvent(w.companyA.id, {
        agentId: worker.id,
        provider: "test",
        model: "test",
        costCents: 150,
        occurredAt: new Date(),
      });
    };
    const run = await wakeAndSettle(worker.id);
    expect(probe.duringSetup).toBeNull();
    expect(probe.launches).toEqual([]);
    expect(run?.status).toBe("cancelled");
    expect(await statusOf(worker.id)).toBe("paused");
  });

  it("run cancellation during setup: no adapter launch, the live agent is not left running", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    const heartbeat = heartbeatService(db());
    probe.duringSetup = async () => {
      const active = await db().select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, worker.id));
      for (const r of active) await heartbeat.cancelRun(r.id);
    };
    const run = await wakeAndSettle(worker.id);
    expect(probe.launches).toEqual([]);
    expect(run?.status).toBe("cancelled");
    await settlesTo(worker.id, "idle");
  });
});

describe("status writers never move a terminated or paused agent (SEC-060)", () => {
  it("run finish: an agent terminated while its adapter ran stays terminated", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    probe.duringExecute = async () => {
      await agentService(db()).terminate(worker.id);
    };
    await wakeAndSettle(worker.id);
    expect(probe.launches).toHaveLength(1);
    expect(await statusOf(worker.id)).toBe("terminated");
  });

  it("run finish: an agent paused while its adapter ran stays paused", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    probe.duringExecute = async () => {
      await agentService(db()).pause(worker.id);
    };
    await wakeAndSettle(worker.id);
    expect(probe.launches).toHaveLength(1);
    expect(await statusOf(worker.id)).toBe("paused");
  });

  it("run start: a terminated agent's queued run is never marked running", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    probe.duringSetup = async () => {
      await db().update(agents).set({ status: "terminated" }).where(eq(agents.id, worker.id));
    };
    await wakeAndSettle(worker.id);
    expect(probe.launches).toEqual([]);
    expect(await statusOf(worker.id)).toBe("terminated");
  });

  it("cost auto-pause: spend over budget does not move a terminated agent to paused", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w, { budgetMonthlyCents: 100, status: "terminated" });
    await costService(db()).createEvent(w.companyA.id, {
      agentId: worker.id,
      provider: "test",
      model: "test",
      costCents: 150,
      occurredAt: new Date(),
    });
    expect(await statusOf(worker.id)).toBe("terminated");
  });

  it("control: cost auto-pause still pauses a live agent over budget", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w, { budgetMonthlyCents: 100 });
    await costService(db()).createEvent(w.companyA.id, {
      agentId: worker.id,
      provider: "test",
      model: "test",
      costCents: 150,
      occurredAt: new Date(),
    });
    expect(await statusOf(worker.id)).toBe("paused");
  });
});

describe("mention wakeups are validated like every other issue wakeup (SEC-056)", () => {
  const commentsOn = (issueId: string) =>
    db().select().from(issueComments).where(eq(issueComments.issueId, issueId));

  it("issue_comment_mentioned with a foreign issue id queues nothing and writes nothing", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    const run = await heartbeatService(db()).wakeup(worker.id, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_comment_mentioned",
      payload: { issueId: w.issueB.id },
    } as any);
    expect(run).toBeNull();
    expect(await db().select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, worker.id))).toHaveLength(0);
    expect(await commentsOn(w.issueB.id)).toHaveLength(0);
    expect(probe.launches).toEqual([]);
  });

  it("control: issue_comment_mentioned with a same-company issue runs", async () => {
    const w = await seedWorld(db());
    const worker = await freshWorker(w);
    const run = await wakeAndSettle(worker.id, {
      reason: "issue_comment_mentioned",
      payload: { issueId: w.issueA.id },
    });
    expect(run?.status).toBe("succeeded");
    expect(probe.launches).toEqual([run!.id]);
  });
});
