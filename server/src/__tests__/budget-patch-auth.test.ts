import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigRevisions, agents, companies } from "@paperclipai/db";
import { send, seedWorld, startRealApp, type RealApp } from "./helpers/real-app.js";

// SEC-055: an existing budget changes only with board access to the agent's
// company. Every path is covered (budgets PATCH, general agent PATCH, config
// rollback), and every rejection asserts the stored budget is unchanged.

let real: RealApp;

beforeAll(async () => {
  real = await startRealApp();
}, 120_000);

afterAll(async () => {
  await real?.stop();
});

const budgetOf = (agentId: string) =>
  real.db
    .select({ budget: agents.budgetMonthlyCents, title: agents.title })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0]!);

describe("PATCH /agents/:agentId/budgets (SEC-055)", () => {
  it("unauthenticated PATCH returns 401 and leaves the stored budget unchanged", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.anonymous, "patch", `/api/agents/${w.agentA.id}/budgets`, {
      budgetMonthlyCents: 999_999,
    });
    expect(res.status).toBe(401);
    expect((await budgetOf(w.agentA.id)).budget).toBe(100);
  });

  it("unauthenticated PATCH on a nonexistent agent returns 401, not 404", async () => {
    const res = await send(
      real.app,
      { kind: "anonymous" },
      "patch",
      "/api/agents/00000000-0000-4000-8000-000000000000/budgets",
      { budgetMonthlyCents: 1 },
    );
    expect(res.status).toBe(401);
  });

  it("an agent cannot raise its own budget", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}/budgets`, {
      budgetMonthlyCents: 999_999,
    });
    expect(res.status).toBe(403);
    expect((await budgetOf(w.agentA.id)).budget).toBe(100);
  });

  it("outsider, former member and foreign agent get 403 and no write", async () => {
    const w = await seedWorld(real.db);
    for (const caller of [w.callers.outsider, w.callers.formerMember, w.callers.foreignAgent]) {
      const res = await send(real.app, caller, "patch", `/api/agents/${w.agentA.id}/budgets`, { budgetMonthlyCents: 5 });
      expect(res.status).toBe(403);
    }
    expect((await budgetOf(w.agentA.id)).budget).toBe(100);
  });

  it("an authorized board member updates the budget", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}/budgets`, {
      budgetMonthlyCents: 4242,
    });
    expect(res.status).toBe(200);
    expect((await budgetOf(w.agentA.id)).budget).toBe(4242);
  });
});

describe("PATCH /agents/:id carrying a budget (SEC-055)", () => {
  it("an agent cannot change its own budget through the general PATCH", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, {
      budgetMonthlyCents: 999_999,
    });
    expect(res.status).toBe(403);
    expect((await budgetOf(w.agentA.id)).budget).toBe(100);
  });

  it("an agent still updates its own non-budget fields", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, {
      title: "Researcher",
      budgetMonthlyCents: 100,
    });
    expect(res.status).toBe(200);
    expect(await budgetOf(w.agentA.id)).toEqual({ budget: 100, title: "Researcher" });
  });

  it("a board member changes the budget through the general PATCH", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, {
      budgetMonthlyCents: 321,
    });
    expect(res.status).toBe(200);
    expect((await budgetOf(w.agentA.id)).budget).toBe(321);
  });
});

describe("config rollback carrying a budget (SEC-055)", () => {
  async function revisionWithBudget(w: Awaited<ReturnType<typeof seedWorld>>) {
    // The board raises the budget (recording a revision whose afterConfig has
    // 777), then lowers it again; rolling back to that revision raises it.
    expect((await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { budgetMonthlyCents: 777 })).status).toBe(200);
    expect((await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { budgetMonthlyCents: 50 })).status).toBe(200);
    const revisions = await real.db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, w.agentA.id));
    const target = revisions.find((r) => (r.afterConfig as Record<string, unknown>).budgetMonthlyCents === 777);
    expect(target).toBeTruthy();
    return target!.id;
  }

  it("an agent cannot restore a higher budget by rolling back its own config", async () => {
    const w = await seedWorld(real.db);
    const revisionId = await revisionWithBudget(w);
    const res = await send(
      real.app,
      w.callers.targetAgent,
      "post",
      `/api/agents/${w.agentA.id}/config-revisions/${revisionId}/rollback`,
    );
    expect(res.status).toBe(403);
    expect((await budgetOf(w.agentA.id)).budget).toBe(50);
  });

  it("a board member rolls the budget back", async () => {
    const w = await seedWorld(real.db);
    const revisionId = await revisionWithBudget(w);
    const res = await send(
      real.app,
      w.callers.member,
      "post",
      `/api/agents/${w.agentA.id}/config-revisions/${revisionId}/rollback`,
    );
    expect(res.status).toBe(200);
    expect((await budgetOf(w.agentA.id)).budget).toBe(777);
  });
});

describe("PATCH /companies/:companyId/budgets (SEC-056)", () => {
  const companyBudget = (id: string) =>
    real.db.select({ budget: companies.budgetMonthlyCents }).from(companies).where(eq(companies.id, id)).then((r) => r[0]!.budget);

  it("outsider and same-company agent get 403 and no write", async () => {
    const w = await seedWorld(real.db);
    for (const caller of [w.callers.outsider, w.callers.peerAgent]) {
      const res = await send(real.app, caller, "patch", `/api/companies/${w.companyA.id}/budgets`, { budgetMonthlyCents: 9 });
      expect(res.status).toBe(403);
    }
    expect(await companyBudget(w.companyA.id)).toBe(0);
  });

  it("a member updates the company budget", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "patch", `/api/companies/${w.companyA.id}/budgets`, {
      budgetMonthlyCents: 9,
    });
    expect(res.status).toBe(200);
    expect(await companyBudget(w.companyA.id)).toBe(9);
  });
});
