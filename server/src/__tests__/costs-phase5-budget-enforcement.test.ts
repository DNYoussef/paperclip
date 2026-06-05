import type { Db } from "@paperclipai/db";
import { agents, companies, costEvents } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { budgetMonthWindow, costService } from "../services/costs.js";

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function buildAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 10_000,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "Budget Co",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 50_000,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: true,
    brandColor: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function tableName(table: unknown) {
  if (table === agents) return "agents";
  if (table === companies) return "companies";
  if (table === costEvents) return "costEvents";
  return "unknown";
}

function createBudgetDb(opts: {
  agent?: Record<string, unknown>;
  company?: Record<string, unknown>;
  agentMonthSpendCents: number;
  companyMonthSpendCents: number;
}) {
  const agent = buildAgent(opts.agent);
  const company = buildCompany(opts.company);
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const insertedValues: Record<string, unknown>[] = [];
  const totals = [opts.agentMonthSpendCents, opts.companyMonthSpendCents];

  const db = {
    select: vi.fn((_selection?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === agents) return thenableRows([agent]);
          if (table === companies) return thenableRows([company]);
          if (table === costEvents) return thenableRows([{ total: totals.shift() ?? 0 }]);
          return thenableRows([]);
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push({ table: tableName(table), ...values });
        return {
          returning: vi.fn(() => thenableRows([{ id: "event-1", ...values }])),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updates.push({ table: tableName(table), patch });
        return {
          where: vi.fn(() => thenableRows([])),
        };
      }),
    })),
  };

  return { db: db as unknown as Db, updates, insertedValues };
}

describe("Phase 5 budget enforcement", () => {
  it("uses the current calendar month spend instead of lifetime counters", async () => {
    const { db, updates } = createBudgetDb({
      agent: {
        spentMonthlyCents: 9_900,
        budgetMonthlyCents: 10_000,
      },
      company: {
        spentMonthlyCents: 40_000,
        budgetMonthlyCents: 50_000,
      },
      agentMonthSpendCents: 200,
      companyMonthSpendCents: 200,
    });

    await costService(db).createEvent("company-1", {
      agentId: "agent-1",
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1,
      outputTokens: 1,
      costCents: 200,
      occurredAt: new Date("2026-02-01T12:00:00.000Z"),
    });

    expect(updates).toContainEqual({
      table: "agents",
      patch: expect.objectContaining({ spentMonthlyCents: 200 }),
    });
    expect(updates).toContainEqual({
      table: "companies",
      patch: expect.objectContaining({ spentMonthlyCents: 200 }),
    });
    expect(updates.some((entry) => entry.patch.status === "paused")).toBe(false);
  });

  it("enforces company monthly budget by pausing future agent work", async () => {
    const { db, updates } = createBudgetDb({
      agent: {
        budgetMonthlyCents: 10_000,
        spentMonthlyCents: 300,
      },
      company: {
        budgetMonthlyCents: 1_000,
        spentMonthlyCents: 900,
      },
      agentMonthSpendCents: 300,
      companyMonthSpendCents: 1_200,
    });

    await costService(db).createEvent("company-1", {
      agentId: "agent-1",
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1,
      outputTokens: 1,
      costCents: 300,
      occurredAt: new Date("2026-02-15T12:00:00.000Z"),
    });

    expect(updates).toContainEqual({
      table: "companies",
      patch: expect.objectContaining({ spentMonthlyCents: 1_200 }),
    });
    expect(updates).toContainEqual({
      table: "agents",
      patch: expect.objectContaining({ status: "paused" }),
    });
  });

  it("computes monthly budget windows in UTC", () => {
    const { from, to } = budgetMonthWindow(new Date("2026-02-28T23:59:59.000Z"));

    expect(from.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});
