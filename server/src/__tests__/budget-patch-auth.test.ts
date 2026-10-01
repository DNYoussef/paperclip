import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { costRoutes } from "../routes/costs.js";
import { ACTORS, COMPANY, appWithActor } from "./helpers/route-actors.js";

// SEC-055: the agent budget PATCH must reject before it writes.
// The stored budget is tracked here so the test asserts status AND no write.
const store = vi.hoisted(() => ({
  agent: { id: "agent-1", companyId: "company-1", status: "active", budgetMonthlyCents: 5000 },
  company: { id: "company-1", budgetMonthlyCents: 20000 },
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async (id: string) => (id === "agent-1" ? { ...store.agent } : null)),
  update: vi.fn(async (_id: string, patch: { budgetMonthlyCents: number }) => {
    store.agent = { ...store.agent, ...patch };
    return { ...store.agent };
  }),
}));

const mockCompanyService = vi.hoisted(() => ({
  update: vi.fn(async (_id: string, patch: { budgetMonthlyCents: number }) => {
    store.company = { ...store.company, ...patch };
    return { ...store.company };
  }),
}));

vi.mock("../services/index.js", () => ({
  costService: () => ({}),
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  logActivity: vi.fn(async () => undefined),
}));

function app(actor: (typeof ACTORS)[keyof typeof ACTORS]) {
  return appWithActor(actor, costRoutes({} as any));
}

describe("PATCH /agents/:agentId/budgets authorization (SEC-055)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.agent = { id: "agent-1", companyId: COMPANY, status: "active", budgetMonthlyCents: 5000 };
    store.company = { id: COMPANY, budgetMonthlyCents: 20000 };
  });

  it("unauthenticated PATCH returns 401 and leaves the stored budget unchanged", async () => {
    const res = await request(app(ACTORS.anonymous))
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 0 });

    expect(res.status).toBe(401);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(store.agent.budgetMonthlyCents).toBe(5000);
  });

  it("unauthenticated PATCH on a nonexistent agent returns 401, not 404", async () => {
    const res = await request(app(ACTORS.anonymous))
      .patch("/api/agents/does-not-exist/budgets")
      .send({ budgetMonthlyCents: 0 });

    expect(res.status).toBe(401);
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("outsider board account gets 403 and no write", async () => {
    const res = await request(app(ACTORS.outsider))
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 0 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(store.agent.budgetMonthlyCents).toBe(5000);
  });

  it("foreign-company agent key gets 403 and no write", async () => {
    const res = await request(app(ACTORS.foreignAgent))
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 1 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("authorized member updates the budget", async () => {
    const res = await request(app(ACTORS.member))
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 7000 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 7000 });
    expect(store.agent.budgetMonthlyCents).toBe(7000);
  });
});

describe("PATCH /companies/:companyId/budgets authorization (SEC-056)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.company = { id: COMPANY, budgetMonthlyCents: 20000 };
  });

  it("outsider board account gets 403 and no write", async () => {
    const res = await request(app(ACTORS.outsider))
      .patch(`/api/companies/${COMPANY}/budgets`)
      .send({ budgetMonthlyCents: 0 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(store.company.budgetMonthlyCents).toBe(20000);
  });

  it("member updates the company budget", async () => {
    const res = await request(app(ACTORS.member))
      .patch(`/api/companies/${COMPANY}/budgets`)
      .send({ budgetMonthlyCents: 100 });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith(COMPANY, { budgetMonthlyCents: 100 });
  });
});
