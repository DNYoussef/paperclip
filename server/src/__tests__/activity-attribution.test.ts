import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../routes/activity.js";
import { ACTORS, COMPANY, OTHER_COMPANY, appWithActor } from "./helpers/route-actors.js";

// SEC-071: POST /companies/:companyId/activity must derive actorType and
// actorId from the authenticated actor, accept only client.* actions and
// only entities owned by the company.
const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(async (data: Record<string, unknown>) => ({ id: "evt-1", ...data })),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(async (id: string) =>
    id === "issue-own"
      ? { id, companyId: "company-1" }
      : id === "issue-foreign"
        ? { id, companyId: "company-other" }
        : null,
  ),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  agentService: () => ({ getById: vi.fn(async () => null) }),
  projectService: () => ({ getById: vi.fn(async () => null) }),
  goalService: () => ({ getById: vi.fn(async () => null) }),
  approvalService: () => ({ getById: vi.fn(async () => null) }),
  heartbeatService: () => ({ getRun: vi.fn() }),
}));

function app(actor: (typeof ACTORS)[keyof typeof ACTORS]) {
  return appWithActor(actor, activityRoutes({} as any));
}

const url = `/api/companies/${COMPANY}/activity`;

describe("POST /companies/:companyId/activity attribution (SEC-071)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a body that supplies actorId or actorType", async () => {
    const res = await request(app(ACTORS.member)).post(url).send({
      actorType: "system",
      actorId: "victim-user",
      action: "client.note",
      entityType: "issue",
      entityId: "issue-own",
    });
    expect(res.status).toBe(400);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("rejects a reserved server action name", async () => {
    for (const action of ["approval.approved", "company.deleted", "agent.terminated"]) {
      const res = await request(app(ACTORS.member)).post(url).send({
        action,
        entityType: "issue",
        entityId: "issue-own",
      });
      expect(res.status).toBe(400);
    }
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("rejects an entity owned by another company", async () => {
    const res = await request(app(ACTORS.member)).post(url).send({
      action: "client.note",
      entityType: "issue",
      entityId: "issue-foreign",
    });
    expect(res.status).toBe(404);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown entity type", async () => {
    const res = await request(app(ACTORS.member)).post(url).send({
      action: "client.note",
      entityType: "secret",
      entityId: "secret-1",
    });
    expect(res.status).toBe(400);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("outsider board account gets 403", async () => {
    const res = await request(app(ACTORS.outsider)).post(url).send({
      action: "client.note",
      entityType: "company",
      entityId: COMPANY,
    });
    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("anonymous caller gets 401", async () => {
    const res = await request(app(ACTORS.anonymous)).post(url).send({
      action: "client.note",
      entityType: "company",
      entityId: COMPANY,
    });
    expect(res.status).toBe(401);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("company entity must be the path company", async () => {
    const res = await request(app(ACTORS.member)).post(url).send({
      action: "client.note",
      entityType: "company",
      entityId: OTHER_COMPANY,
    });
    expect(res.status).toBe(404);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("persists the authenticated actor, never the body", async () => {
    const res = await request(app(ACTORS.member)).post(url).send({
      action: "client.note",
      entityType: "issue",
      entityId: "issue-own",
      details: { text: "hello" },
    });
    expect(res.status).toBe(201);
    expect(mockActivityService.create).toHaveBeenCalledTimes(1);
    const persisted = mockActivityService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(persisted.companyId).toBe(COMPANY);
    expect(persisted.actorType).toBe("user");
    expect(persisted.actorId).toBe("member-user");
    expect(persisted.action).toBe("client.note");
    expect(persisted.agentId).toBeNull();
  });
});
