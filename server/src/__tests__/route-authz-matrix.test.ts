import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentApiKeys, agents, approvals, companies, heartbeatRuns } from "@paperclipai/db";
import { send, seedWorld, startRealApp, type Caller, type RealApp, type World } from "./helpers/real-app.js";

// SEC-056 router-level matrix over the real app and a real PostgreSQL. Each
// case seeds a fresh world, then calls the route as: anonymous, an outsider
// board account (member of company B only), a former member (membership
// removed through accessService), a suspended member, a foreign-company agent
// key, a same-company agent key, and an authorized member. Every rejected
// call must leave the stored state unchanged; the authorized call must
// succeed and (for mutations) change it.

let real: RealApp;

beforeAll(async () => {
  real = await startRealApp();
}, 120_000);

afterAll(async () => {
  await real?.stop();
});

type Method = "get" | "post" | "patch" | "delete";

interface RouteCase {
  name: string;
  method: Method;
  path: (w: World) => string;
  body?: (w: World) => unknown;
  // How a same-company agent key is treated: board-only routes refuse it.
  agent: "forbidden" | "allowed";
  // Status for a caller with no access to company A (default 403).
  noAccessStatus?: number;
  prepare?: (w: World) => Promise<void>;
  // Stored state the route mutates; undefined for read-only routes.
  state?: (w: World) => Promise<unknown>;
}

const db = () => real.db;

const agentRow = (id: string) =>
  db()
    .select({ status: agents.status, budget: agents.budgetMonthlyCents, updatedAt: agents.updatedAt })
    .from(agents)
    .where(eq(agents.id, id))
    .then((rows) => rows[0] ?? null);

const CASES: RouteCase[] = [
  { name: "POST /agents/:id/pause", method: "post", path: (w) => `/api/agents/${w.agentA.id}/pause`, agent: "forbidden", state: (w) => agentRow(w.agentA.id) },
  { name: "POST /agents/:id/resume", method: "post", path: (w) => `/api/agents/${w.agentA.id}/resume`, agent: "forbidden", state: (w) => agentRow(w.agentA.id) },
  { name: "POST /agents/:id/terminate", method: "post", path: (w) => `/api/agents/${w.agentA.id}/terminate`, agent: "forbidden", state: (w) => agentRow(w.agentA.id) },
  { name: "DELETE /agents/:id", method: "delete", path: (w) => `/api/agents/${w.agentA.id}`, agent: "forbidden", state: (w) => agentRow(w.agentA.id) },
  { name: "GET /agents/:id/keys", method: "get", path: (w) => `/api/agents/${w.agentA.id}/keys`, agent: "forbidden" },
  {
    name: "POST /agents/:id/keys",
    method: "post",
    path: (w) => `/api/agents/${w.agentA.id}/keys`,
    body: () => ({ name: "new" }),
    agent: "forbidden",
    state: (w) => db().select({ n: count() }).from(agentApiKeys).where(eq(agentApiKeys.agentId, w.agentA.id)).then((r) => r[0]!.n),
  },
  {
    name: "DELETE /agents/:id/keys/:keyId",
    method: "delete",
    path: (w) => `/api/agents/${w.agentA.id}/keys/${w.keyA.id}`,
    agent: "forbidden",
    state: (w) => db().select({ revokedAt: agentApiKeys.revokedAt }).from(agentApiKeys).where(eq(agentApiKeys.id, w.keyA.id)).then((r) => r[0]),
  },
  {
    name: "POST /heartbeat-runs/:runId/cancel",
    method: "post",
    path: (w) => `/api/heartbeat-runs/${w.runA.id}/cancel`,
    agent: "forbidden",
    state: (w) => db().select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, w.runA.id)).then((r) => r[0]),
  },
  ...(["approve", "reject", "request-revision"] as const).map(
    (action): RouteCase => ({
      name: `POST /approvals/:id/${action}`,
      method: "post",
      path: (w) => `/api/approvals/${w.approvalA.id}/${action}`,
      body: () => ({}),
      agent: "forbidden",
      state: (w) => db().select({ status: approvals.status }).from(approvals).where(eq(approvals.id, w.approvalA.id)).then((r) => r[0]),
    }),
  ),
  {
    name: "POST /approvals/:id/resubmit",
    method: "post",
    path: (w) => `/api/approvals/${w.approvalA.id}/resubmit`,
    body: () => ({ payload: { plan: "v2" } }),
    agent: "forbidden",
    prepare: async (w) => {
      await db().update(approvals).set({ status: "revision_requested" }).where(eq(approvals.id, w.approvalA.id));
    },
    state: (w) => db().select({ status: approvals.status, payload: approvals.payload }).from(approvals).where(eq(approvals.id, w.approvalA.id)).then((r) => r[0]),
  },
  {
    name: "POST /companies/:companyId/approvals",
    method: "post",
    path: (w) => `/api/companies/${w.companyA.id}/approvals`,
    body: () => ({ type: "approve_ceo_strategy", payload: { plan: "x" } }),
    agent: "allowed",
    state: (w) => db().select({ n: count() }).from(approvals).where(eq(approvals.companyId, w.companyA.id)).then((r) => r[0]!.n),
  },
  { name: "GET /approvals/:id", method: "get", path: (w) => `/api/approvals/${w.approvalA.id}`, agent: "allowed" },
  {
    name: "PATCH /companies/:companyId/budgets",
    method: "patch",
    path: (w) => `/api/companies/${w.companyA.id}/budgets`,
    body: () => ({ budgetMonthlyCents: 777 }),
    agent: "forbidden",
    state: (w) => db().select({ budget: companies.budgetMonthlyCents }).from(companies).where(eq(companies.id, w.companyA.id)).then((r) => r[0]),
  },
  {
    name: "PATCH /agents/:agentId/budgets",
    method: "patch",
    path: (w) => `/api/agents/${w.agentA.id}/budgets`,
    body: () => ({ budgetMonthlyCents: 777 }),
    agent: "forbidden",
    state: (w) => agentRow(w.agentA.id),
  },
  {
    name: "PATCH /agents/:id (budget)",
    method: "patch",
    path: (w) => `/api/agents/${w.agentA.id}`,
    body: () => ({ budgetMonthlyCents: 777 }),
    agent: "forbidden",
    state: (w) => agentRow(w.agentA.id),
  },
  {
    name: "POST /companies/:companyId/activity",
    method: "post",
    path: (w) => `/api/companies/${w.companyA.id}/activity`,
    body: (w) => ({ action: "client.note", entityType: "company", entityId: w.companyA.id }),
    agent: "forbidden",
    state: (w) => db().select({ n: count() }).from(activityLog).where(eq(activityLog.companyId, w.companyA.id)).then((r) => r[0]!.n),
  },
  { name: "GET /heartbeat-runs/:runId/issues", method: "get", path: (w) => `/api/heartbeat-runs/${w.runA.id}/issues`, agent: "allowed" },
  { name: "GET /agents/:id", method: "get", path: (w) => `/api/agents/${w.agentA.id}`, agent: "allowed", noAccessStatus: 404 },
];

async function snapshot(c: RouteCase, w: World) {
  return c.state ? JSON.stringify(await c.state(w)) : null;
}

describe("company authorization matrix (real app, real database)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const w = await seedWorld(db());
      await c.prepare?.(w);
      const before = await snapshot(c, w);
      const noAccess = c.noAccessStatus ?? 403;

      const rejected: Array<[string, Caller, number]> = [
        ["anonymous", w.callers.anonymous, 401],
        ["outsider", w.callers.outsider, noAccess],
        ["formerMember", w.callers.formerMember, noAccess],
        ["suspendedMember", w.callers.suspendedMember, noAccess],
        ["foreignAgent", w.callers.foreignAgent, noAccess],
      ];
      if (c.agent === "forbidden") rejected.push(["sameCompanyAgent", w.callers.peerAgent, 403]);

      for (const [label, caller, status] of rejected) {
        const res = await send(real.app, caller, c.method, c.path(w), c.body?.(w));
        expect({ label, status: res.status }).toEqual({ label, status });
        expect({ label, state: await snapshot(c, w) }).toEqual({ label, state: before });
      }

      const allowed: Array<[string, Caller]> = [["member", w.callers.member]];
      if (c.agent === "allowed") allowed.push(["sameCompanyAgent", w.callers.peerAgent]);
      for (const [label, caller] of allowed) {
        const res = await send(real.app, caller, c.method, c.path(w), c.body?.(w));
        expect({ label, ok: [200, 201].includes(res.status), status: res.status }).toMatchObject({ label, ok: true });
      }
      if (c.state) expect(await snapshot(c, w)).not.toEqual(before);
    });
  }

  it("GET /agents/:id: an outsider gets the same 404 for a foreign agent as for a missing one", async () => {
    const w = await seedWorld(db());
    const foreign = await send(real.app, w.callers.outsider, "get", `/api/agents/${w.agentA.id}`);
    const missing = await send(real.app, w.callers.outsider, "get", "/api/agents/00000000-0000-4000-8000-000000000000");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain(w.agentA.name);
  });

  it("DELETE /agents/:id/keys/:keyId: a key of another agent is a 404 and stays valid", async () => {
    const w = await seedWorld(db());
    const res = await send(real.app, w.callers.member, "delete", `/api/agents/${w.agentA.id}/keys/${w.keyPeerA.id}`);
    expect(res.status).toBe(404);
    const row = await db()
      .select({ revokedAt: agentApiKeys.revokedAt })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.id, w.keyPeerA.id)))
      .then((r) => r[0]);
    expect(row?.revokedAt).toBeNull();
  });
});

describe("approval decision attribution (SEC-058)", () => {
  for (const action of ["approve", "reject", "request-revision"]) {
    it(`${action}: a body carrying decidedByUserId is rejected and nothing changes`, async () => {
      const w = await seedWorld(db());
      const res = await send(real.app, w.callers.member, "post", `/api/approvals/${w.approvalA.id}/${action}`, {
        decidedByUserId: "victim-user",
      });
      expect(res.status).toBe(400);
      const row = await db().select().from(approvals).where(eq(approvals.id, w.approvalA.id)).then((r) => r[0]!);
      expect(row.status).toBe("pending");
      expect(row.decidedByUserId).toBeNull();
    });

    it(`${action}: records the authenticated user`, async () => {
      const w = await seedWorld(db());
      const res = await send(real.app, w.callers.member, "post", `/api/approvals/${w.approvalA.id}/${action}`, {
        decisionNote: "ok",
      });
      expect(res.status).toBe(200);
      const row = await db().select().from(approvals).where(eq(approvals.id, w.approvalA.id)).then((r) => r[0]!);
      expect(row.decidedByUserId).toBe(w.users.member);
    });
  }
});
