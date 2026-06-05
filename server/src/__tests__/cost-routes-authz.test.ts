import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { costRoutes } from "../routes/costs.js";

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  costService: () => mockCostService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("cost route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects company budget changes before mutation when board user lacks company access", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch("/api/companies/company-2/budgets")
      .send({ budgetMonthlyCents: 1000 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows company budget changes after board company access passes", async () => {
    mockCompanyService.update.mockResolvedValue({
      id: "company-1",
      budgetMonthlyCents: 1000,
    });

    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 1000 });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { budgetMonthlyCents: 1000 });
  });

  it("rejects agent budget changes before mutation when board user lacks target company access", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-2",
      companyId: "company-2",
    });

    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch("/api/agents/agent-2/budgets")
      .send({ budgetMonthlyCents: 1000 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent actors changing another agent budget before mutation", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-2",
      companyId: "company-1",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    }))
      .patch("/api/agents/agent-2/budgets")
      .send({ budgetMonthlyCents: 1000 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
