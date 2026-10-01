import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentConfigRevisions, agents, companies } from "@paperclipai/db";
import { send, seedWorld, startRealApp, type RealApp } from "./helpers/real-app.js";

// Deterministic interleaving hook: the agent PATCH route awaits adapter-config
// normalization between its authorization check and its write. A test sets
// hooks.duringNormalize to run a concurrent writer exactly in that gap.
const hooks = vi.hoisted(() => ({ duringNormalize: null as null | (() => Promise<void>) }));
vi.mock("../services/secrets.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/secrets.js")>();
  return {
    ...mod,
    secretService: (db: any) => {
      const svc = mod.secretService(db);
      return {
        ...svc,
        normalizeAdapterConfigForPersistence: async (...args: Parameters<typeof svc.normalizeAdapterConfigForPersistence>) => {
          const result = await svc.normalizeAdapterConfigForPersistence(...args);
          const hook = hooks.duringNormalize;
          hooks.duringNormalize = null;
          if (hook) await hook();
          return result;
        },
      };
    },
  };
});

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

describe("spend accounting is server-owned (SEC-055)", () => {
  const spentOf = (agentId: string) =>
    real.db.select({ spent: agents.spentMonthlyCents }).from(agents).where(eq(agents.id, agentId)).then((r) => r[0]!.spent);

  it("an agent cannot reset its own spentMonthlyCents through PATCH", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ spentMonthlyCents: 500 }).where(eq(agents.id, w.agentA.id));
    const res = await send(real.app, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, {
      spentMonthlyCents: 0,
    });
    expect(res.status).toBe(403);
    expect(await spentOf(w.agentA.id)).toBe(500);
  });

  it("an agent cannot change spend and a harmless field together", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ spentMonthlyCents: 500 }).where(eq(agents.id, w.agentA.id));
    const res = await send(real.app, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, {
      title: "x",
      spentMonthlyCents: 0,
    });
    expect(res.status).toBe(403);
    expect(await spentOf(w.agentA.id)).toBe(500);
    expect((await budgetOf(w.agentA.id)).title).toBeNull();
  });

  it("a board member may correct spend", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ spentMonthlyCents: 500 }).where(eq(agents.id, w.agentA.id));
    const res = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, {
      spentMonthlyCents: 0,
    });
    expect(res.status).toBe(200);
    expect(await spentOf(w.agentA.id)).toBe(0);
  });
});

describe("non-board writes never store accounting fields (SEC-055)", () => {
  const accountingOf = (agentId: string) =>
    real.db
      .select({ budget: agents.budgetMonthlyCents, spent: agents.spentMonthlyCents, title: agents.title })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0]!);

  it("an agent PATCH echoing unchanged accounting values does not overwrite a concurrent spend increment or board budget cut", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ spentMonthlyCents: 500, budgetMonthlyCents: 1000 }).where(eq(agents.id, w.agentA.id));
    hooks.duringNormalize = async () => {
      // A cost event and a board budget reduction land between the route's
      // check and its write.
      await real.db.update(agents).set({ spentMonthlyCents: 525, budgetMonthlyCents: 600 }).where(eq(agents.id, w.agentA.id));
    };
    const res = await send(real.app, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, {
      title: "Echo",
      adapterConfig: {},
      spentMonthlyCents: 500,
      budgetMonthlyCents: 1000,
    });
    expect(hooks.duringNormalize).toBeNull();
    expect(res.status).toBe(200);
    expect(await accountingOf(w.agentA.id)).toEqual({ budget: 600, spent: 525, title: "Echo" });
  });

  it("an agent rollback to a revision with an equal budget keeps the stored budget and rolls back the rest", async () => {
    const w = await seedWorld(real.db);
    expect((await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { title: "v1" })).status).toBe(200);
    expect((await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { title: "v2" })).status).toBe(200);
    const revisions = await real.db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, w.agentA.id));
    const v1 = revisions.find((r) => (r.afterConfig as Record<string, unknown>).title === "v1")!;
    const res = await send(real.app, w.callers.targetAgent, "post", `/api/agents/${w.agentA.id}/config-revisions/${v1.id}/rollback`);
    expect(res.status).toBe(200);
    expect(await accountingOf(w.agentA.id)).toMatchObject({ title: "v1", budget: 100 });
  });
});

describe("company import replace is a board operation (SEC-055)", () => {
  async function bundleWithBudget(w: Awaited<ReturnType<typeof seedWorld>>, budget: number) {
    const exported = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/export`, {
      include: { company: false, agents: true },
    });
    expect(exported.status).toBe(200);
    const manifest = exported.body.manifest;
    for (const agent of manifest.agents) agent.budgetMonthlyCents = budget;
    return {
      source: { type: "inline", manifest, files: exported.body.files },
      include: { company: false, agents: true },
      target: { mode: "existing_company", companyId: w.companyA.id },
      collisionStrategy: "replace",
    };
  }

  it("an agent import with collisionStrategy=replace is refused before any write", async () => {
    const w = await seedWorld(real.db);
    const body = await bundleWithBudget(w, 999_999);
    for (const caller of [w.callers.targetAgent, w.callers.peerAgent]) {
      const res = await send(real.app, caller, "post", "/api/companies/import", body);
      expect(res.status).toBe(403);
    }
    expect((await budgetOf(w.agentA.id)).budget).toBe(100);
    expect((await budgetOf(w.peerA.id)).budget).toBe(100);
  });

  it("a board member import replaces the budgets", async () => {
    const w = await seedWorld(real.db);
    const body = await bundleWithBudget(w, 4321);
    const res = await send(real.app, w.callers.member, "post", "/api/companies/import", body);
    expect(res.status).toBe(200);
    expect((await budgetOf(w.agentA.id)).budget).toBe(4321);
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
