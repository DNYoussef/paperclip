import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../routes/activity.js";
import { ACTORS, COMPANY, appWithActor } from "./helpers/route-actors.js";

// SEC-056 (grown): GET /heartbeat-runs/:runId/issues leaked issue metadata
// to anonymous callers. It must 401 for type none, 404 for an unknown run,
// 403 for an outsider, and only then query the issues.
const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(async () => [
    { issueId: "issue-1", identifier: "PAP-1", title: "private title", status: "todo", priority: "high" },
  ]),
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async (runId: string) =>
    runId === "run-1" ? { id: "run-1", companyId: "company-1", agentId: "agent-1" } : null,
  ),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => ({ getById: vi.fn(), getByIdentifier: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  projectService: () => ({ getById: vi.fn() }),
  goalService: () => ({ getById: vi.fn() }),
  approvalService: () => ({ getById: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
}));

function app(actor: (typeof ACTORS)[keyof typeof ACTORS]) {
  return appWithActor(actor, activityRoutes({} as any));
}

describe("GET /heartbeat-runs/:runId/issues authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("anonymous caller gets 401 and no issue query", async () => {
    const res = await request(app(ACTORS.anonymous)).get("/api/heartbeat-runs/run-1/issues");
    expect(res.status).toBe(401);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("private title");
  });

  it("anonymous caller gets 401 even for an unknown run", async () => {
    const res = await request(app(ACTORS.anonymous)).get("/api/heartbeat-runs/nope/issues");
    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
  });

  it("outsider board account gets 403 and no issue query", async () => {
    const res = await request(app(ACTORS.outsider)).get("/api/heartbeat-runs/run-1/issues");
    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("foreign-company agent key gets 403", async () => {
    const res = await request(app(ACTORS.foreignAgent)).get("/api/heartbeat-runs/run-1/issues");
    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("member gets 404 for an unknown run", async () => {
    const res = await request(app(ACTORS.member)).get("/api/heartbeat-runs/nope/issues");
    expect(res.status).toBe(404);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("member reads the issues of a run in their company", async () => {
    const res = await request(app(ACTORS.member)).get("/api/heartbeat-runs/run-1/issues");
    expect(res.status).toBe(200);
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith("run-1", COMPANY);
    expect(res.body[0].title).toBe("private title");
  });
});
