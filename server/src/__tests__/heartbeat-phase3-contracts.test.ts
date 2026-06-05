import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  costService: vi.fn(() => ({
    createEvent: vi.fn(),
  })),
}));

vi.mock("../services/costs.js", () => ({
  costService: mocks.costService,
}));

import {
  claimQueuedHeartbeatRunForCapacity,
  heartbeatService,
} from "../services/heartbeat.ts";

function buildQueuedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "queued",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    contextSnapshot: null,
    createdAt: new Date("2026-06-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  } as never;
}

function buildAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Test Agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-06-03T00:00:00.000Z"),
    updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    ...overrides,
  } as never;
}

function createClaimDb(opts: { runningCount: number }) {
  const events: string[] = [];
  const agent = buildAgent();
  const updateSets: Array<Record<string, unknown>> = [];

  const tx = {
    execute: vi.fn(async () => {
      events.push("lock-agent");
    }),
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => {
            const isCountSelect = Boolean(selection && "count" in selection);
            events.push(isCountSelect ? "count-running" : "select-agent");
            const rows = isCountSelect ? [{ count: opts.runningCount }] : [agent];
            return Promise.resolve(rows).then(resolve);
          },
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updateSets.push(patch);
        events.push("claim-run");
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => ({
              then: (resolve: (rows: unknown[]) => unknown) =>
                Promise.resolve([{ ...buildQueuedRun(), ...patch }]).then(resolve),
            })),
          })),
        };
      }),
    })),
  };

  return {
    db: {
      transaction: vi.fn((fn: (txArg: typeof tx) => unknown) => fn(tx)),
    } as unknown as Db,
    events,
    tx,
    updateSets,
  };
}

describe("claimQueuedHeartbeatRunForCapacity", () => {
  it("locks the agent row and refuses a queued claim when capacity is already full", async () => {
    const { db, events, tx } = createClaimDb({ runningCount: 1 });

    const claimed = await claimQueuedHeartbeatRunForCapacity({
      db,
      run: buildQueuedRun(),
      claimedAt: new Date("2026-06-03T12:00:00.000Z"),
      maxConcurrentRunsForAgent: () => 1,
    });

    expect(claimed).toBeNull();
    expect(tx.update).not.toHaveBeenCalled();
    expect(events).toEqual(["lock-agent", "select-agent", "count-running"]);
  });

  it("claims exactly one queued run after the locked capacity check passes", async () => {
    const claimedAt = new Date("2026-06-03T12:00:00.000Z");
    const { db, events, tx, updateSets } = createClaimDb({ runningCount: 0 });

    const claimed = await claimQueuedHeartbeatRunForCapacity({
      db,
      run: buildQueuedRun(),
      claimedAt,
      maxConcurrentRunsForAgent: () => 1,
    });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(updateSets[0]).toMatchObject({
      status: "running",
      startedAt: claimedAt,
      updatedAt: claimedAt,
    });
    expect(claimed).toMatchObject({
      id: "run-1",
      status: "running",
      startedAt: claimedAt,
    });
    expect(events).toEqual(["lock-agent", "select-agent", "count-running", "claim-run"]);
  });
});

describe("heartbeatService cost dependency", () => {
  it("constructs costService once per heartbeat service instance", () => {
    mocks.costService.mockClear();

    heartbeatService({} as Db);

    expect(mocks.costService).toHaveBeenCalledTimes(1);
  });
});
