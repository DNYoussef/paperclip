import request from "supertest";
import type { Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTORS, COMPANY, appWithActor, type ActorName } from "./helpers/route-actors.js";

// SEC-056 router-level matrix: every listed mutating or disclosing route is
// exercised with an anonymous caller, an outsider board account, a former
// member, a foreign-company agent key and an authorized member. Rejected
// callers must not reach the service mutation.

const mocks = vi.hoisted(() => {
  const AGENT_ID = "11111111-1111-4111-8111-111111111111";
  const agent = { id: AGENT_ID, companyId: "company-1", status: "active", budgetMonthlyCents: 100 };
  const run = { id: "run-1", companyId: "company-1", agentId: AGENT_ID, status: "running" };
  const approval = {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status: "pending",
    payload: {},
    requestedByAgentId: null,
  };
  return {
    AGENT_ID,
    agents: {
      getById: vi.fn(async (id: string) => (id === AGENT_ID ? { ...agent } : null)),
      pause: vi.fn(async () => ({ ...agent, status: "paused" })),
      resume: vi.fn(async () => ({ ...agent })),
      terminate: vi.fn(async () => ({ ...agent, status: "terminated" })),
      remove: vi.fn(async () => ({ ...agent })),
      update: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...agent, ...patch })),
      listKeys: vi.fn(async () => [{ id: "key-1", name: "k", createdAt: new Date(), revokedAt: null }]),
      createApiKey: vi.fn(async () => ({ id: "key-1", name: "k", token: "redacted", createdAt: new Date() })),
      revokeKey: vi.fn(async (agentId: string, keyId: string) =>
        agentId === AGENT_ID && keyId === "key-1" ? { id: "key-1" } : null,
      ),
    },
    heartbeat: {
      getRun: vi.fn(async (id: string) => (id === "run-1" ? { ...run } : null)),
      cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
      cancelActiveForAgent: vi.fn(async () => undefined),
      wakeup: vi.fn(async () => ({ id: "wake-1" })),
    },
    approvals: {
      getById: vi.fn(async (id: string) => (id === "approval-1" ? { ...approval } : null)),
      approve: vi.fn(async () => ({ approval: { ...approval, status: "approved" }, applied: true })),
      reject: vi.fn(async () => ({ approval: { ...approval, status: "rejected" }, applied: true })),
      requestRevision: vi.fn(async () => ({ ...approval, status: "revision_requested" })),
    },
    companies: {
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    },
    activity: {
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: "evt-1", ...data })),
      issuesForRun: vi.fn(async () => [{ issueId: "issue-1", title: "private" }]),
      list: vi.fn(),
      forIssue: vi.fn(),
      runsForIssue: vi.fn(),
    },
    issues: {
      getById: vi.fn(async () => null),
      getByIdentifier: vi.fn(async () => null),
    },
    logActivity: vi.fn(async () => undefined),
  };
});

const AGENT_ID = mocks.AGENT_ID;

vi.mock("../services/index.js", () => ({
  agentService: () => mocks.agents,
  accessService: () => ({}),
  approvalService: () => mocks.approvals,
  heartbeatService: () => mocks.heartbeat,
  issueApprovalService: () => ({ listIssuesForApproval: vi.fn(async () => []) }),
  issueService: () => mocks.issues,
  projectService: () => ({ getById: vi.fn(async () => null) }),
  goalService: () => ({ getById: vi.fn(async () => null) }),
  secretService: () => ({}),
  costService: () => ({}),
  companyService: () => mocks.companies,
  logActivity: mocks.logActivity,
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mocks.activity,
}));

const { agentRoutes } = await import("../routes/agents.js");
const { approvalRoutes } = await import("../routes/approvals.js");
const { costRoutes } = await import("../routes/costs.js");
const { activityRoutes } = await import("../routes/activity.js");

type Method = "get" | "post" | "patch" | "delete";

interface RouteCase {
  name: string;
  method: Method;
  path: string;
  body?: Record<string, unknown>;
  routes: () => Router;
  sideEffect: () => { mock: { calls: unknown[][] } };
}

const CASES: RouteCase[] = [
  { name: "POST /agents/:id/pause", method: "post", path: `/api/agents/${AGENT_ID}/pause`, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.pause },
  { name: "POST /agents/:id/resume", method: "post", path: `/api/agents/${AGENT_ID}/resume`, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.resume },
  { name: "POST /agents/:id/terminate", method: "post", path: `/api/agents/${AGENT_ID}/terminate`, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.terminate },
  { name: "DELETE /agents/:id", method: "delete", path: `/api/agents/${AGENT_ID}`, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.remove },
  { name: "GET /agents/:id/keys", method: "get", path: `/api/agents/${AGENT_ID}/keys`, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.listKeys },
  { name: "POST /agents/:id/keys", method: "post", path: `/api/agents/${AGENT_ID}/keys`, body: { name: "k" }, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.createApiKey },
  { name: "DELETE /agents/:id/keys/:keyId", method: "delete", path: `/api/agents/${AGENT_ID}/keys/key-1`, routes: () => agentRoutes({} as any), sideEffect: () => mocks.agents.revokeKey },
  { name: "POST /heartbeat-runs/:runId/cancel", method: "post", path: "/api/heartbeat-runs/run-1/cancel", routes: () => agentRoutes({} as any), sideEffect: () => mocks.heartbeat.cancelRun },
  { name: "POST /approvals/:id/approve", method: "post", path: "/api/approvals/approval-1/approve", body: {}, routes: () => approvalRoutes({} as any), sideEffect: () => mocks.approvals.approve },
  { name: "POST /approvals/:id/reject", method: "post", path: "/api/approvals/approval-1/reject", body: {}, routes: () => approvalRoutes({} as any), sideEffect: () => mocks.approvals.reject },
  { name: "POST /approvals/:id/request-revision", method: "post", path: "/api/approvals/approval-1/request-revision", body: {}, routes: () => approvalRoutes({} as any), sideEffect: () => mocks.approvals.requestRevision },
  { name: "PATCH /companies/:companyId/budgets", method: "patch", path: `/api/companies/${COMPANY}/budgets`, body: { budgetMonthlyCents: 1 }, routes: () => costRoutes({} as any), sideEffect: () => mocks.companies.update },
  { name: "PATCH /agents/:agentId/budgets", method: "patch", path: `/api/agents/${AGENT_ID}/budgets`, body: { budgetMonthlyCents: 1 }, routes: () => costRoutes({} as any), sideEffect: () => mocks.agents.update },
  { name: "POST /companies/:companyId/activity", method: "post", path: `/api/companies/${COMPANY}/activity`, body: { action: "client.note", entityType: "company", entityId: COMPANY }, routes: () => activityRoutes({} as any), sideEffect: () => mocks.activity.create },
  { name: "GET /heartbeat-runs/:runId/issues", method: "get", path: "/api/heartbeat-runs/run-1/issues", routes: () => activityRoutes({} as any), sideEffect: () => mocks.activity.issuesForRun },
];

const REJECTED: Array<{ actor: ActorName; status: number }> = [
  { actor: "anonymous", status: 401 },
  { actor: "outsider", status: 403 },
  { actor: "formerMember", status: 403 },
  { actor: "foreignAgent", status: 403 },
];

async function call(actor: ActorName, c: RouteCase) {
  const app = appWithActor(ACTORS[actor], c.routes());
  const req = request(app)[c.method](c.path);
  return c.body ? req.send(c.body) : req;
}

describe("company authorization matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const c of CASES) {
    describe(c.name, () => {
      for (const { actor, status } of REJECTED) {
        it(`${actor} -> ${status} and no side effect`, async () => {
          const res = await call(actor, c);
          expect(res.status).toBe(status);
          expect(c.sideEffect().mock.calls.length).toBe(0);
        });
      }

      it("member -> success and side effect", async () => {
        const res = await call("member", c);
        expect([200, 201]).toContain(res.status);
        expect(c.sideEffect().mock.calls.length).toBe(1);
      });
    });
  }
});

describe("key revocation is scoped by (agentId, keyId)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a keyId that does not belong to the agent is a 404", async () => {
    const res = await request(appWithActor(ACTORS.member, agentRoutes({} as any))).delete(
      `/api/agents/${AGENT_ID}/keys/key-foreign`,
    );
    expect(res.status).toBe(404);
    expect(mocks.agents.revokeKey).toHaveBeenCalledWith(AGENT_ID, "key-foreign");
  });
});

describe("approval decision attribution (SEC-058)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const action of ["approve", "reject", "request-revision"]) {
    it(`${action}: a body carrying decidedByUserId is rejected`, async () => {
      const res = await request(appWithActor(ACTORS.member, approvalRoutes({} as any)))
        .post(`/api/approvals/approval-1/${action}`)
        .send({ decidedByUserId: "victim-user" });
      expect(res.status).toBe(400);
      expect(mocks.approvals.approve).not.toHaveBeenCalled();
      expect(mocks.approvals.reject).not.toHaveBeenCalled();
      expect(mocks.approvals.requestRevision).not.toHaveBeenCalled();
    });
  }

  it("approve records the authenticated user", async () => {
    const res = await request(appWithActor(ACTORS.member, approvalRoutes({} as any)))
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "ok" });
    expect(res.status).toBe(200);
    expect(mocks.approvals.approve).toHaveBeenCalledWith("approval-1", "member-user", "ok");
  });

  it("reject records the authenticated user", async () => {
    await request(appWithActor(ACTORS.member, approvalRoutes({} as any)))
      .post("/api/approvals/approval-1/reject")
      .send({});
    expect(mocks.approvals.reject).toHaveBeenCalledWith("approval-1", "member-user", undefined);
  });

  it("request-revision records the authenticated user", async () => {
    await request(appWithActor(ACTORS.member, approvalRoutes({} as any)))
      .post("/api/approvals/approval-1/request-revision")
      .send({});
    expect(mocks.approvals.requestRevision).toHaveBeenCalledWith("approval-1", "member-user", undefined);
  });
});
