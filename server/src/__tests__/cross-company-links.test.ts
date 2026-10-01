import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goals, issues, projects } from "@paperclipai/db";
import { assertGoalsInCompany, assertIssueRefsInCompany } from "../services/company-scoped-refs.js";
import { ACTORS, COMPANY, OTHER_COMPANY, appWithActor } from "./helpers/route-actors.js";

// SEC-062: issue and project relationships must stay inside one company.
// Write side: the reference checks used by the issue and project services.
// Read side: GET /issues/:id returns no foreign project or goal.

function fakeDb(rowsByTable: Map<unknown, Array<{ id: string }>>) {
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => Promise.resolve(rowsByTable.get(table) ?? []),
    }),
  }));
  return { db: { select } as any, select };
}

describe("assertIssueRefsInCompany", () => {
  it("rejects a project from another company", async () => {
    const { db } = fakeDb(new Map([[goals, [{ id: "g" }]], [issues, [{ id: "p" }]]]));
    await expect(
      assertIssueRefsInCompany(db, COMPANY, { projectId: "proj-foreign", goalId: "g", parentId: "p" }),
    ).rejects.toMatchObject({ status: 404, message: "Project not found" });
  });

  it("rejects a goal from another company", async () => {
    const { db } = fakeDb(new Map([[projects, [{ id: "pr" }]], [issues, [{ id: "p" }]]]));
    await expect(
      assertIssueRefsInCompany(db, COMPANY, { projectId: "pr", goalId: "goal-foreign", parentId: "p" }),
    ).rejects.toMatchObject({ status: 404, message: "Goal not found" });
  });

  it("rejects a parent issue from another company", async () => {
    const { db } = fakeDb(new Map([[projects, [{ id: "pr" }]], [goals, [{ id: "g" }]]]));
    await expect(
      assertIssueRefsInCompany(db, COMPANY, { parentId: "issue-foreign" }),
    ).rejects.toMatchObject({ status: 404, message: "Parent issue not found" });
  });

  it("accepts same-company references and skips absent ones", async () => {
    const { db, select } = fakeDb(new Map([[projects, [{ id: "pr" }]], [goals, [{ id: "g" }]], [issues, [{ id: "p" }]]]));
    await expect(
      assertIssueRefsInCompany(db, COMPANY, { projectId: "pr", goalId: "g", parentId: "p" }),
    ).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledTimes(3);

    select.mockClear();
    await expect(assertIssueRefsInCompany(db, COMPANY, { projectId: null, goalId: undefined })).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});

describe("assertGoalsInCompany", () => {
  it("rejects when any goal id is missing from the company", async () => {
    const { db } = fakeDb(new Map([[goals, [{ id: "g1" }]]]));
    await expect(assertGoalsInCompany(db, COMPANY, ["g1", "goal-foreign"])).rejects.toMatchObject({
      status: 404,
      message: "Goal not found",
    });
  });

  it("accepts when every goal belongs to the company", async () => {
    const { db } = fakeDb(new Map([[goals, [{ id: "g1" }, { id: "g2" }]]]));
    await expect(assertGoalsInCompany(db, COMPANY, ["g1", "g2", "g1"])).resolves.toBeUndefined();
  });

  it("does not query for an empty list", async () => {
    const { db, select } = fakeDb(new Map());
    await expect(assertGoalsInCompany(db, COMPANY, [])).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});

const readMocks = vi.hoisted(() => ({
  issues: {
    getById: vi.fn(),
    getByIdentifier: vi.fn(async () => null),
    getAncestors: vi.fn(async () => []),
    findMentionedProjectIds: vi.fn(async () => []),
  },
  projects: { getById: vi.fn(), listByIds: vi.fn(async () => []) },
  goals: { getById: vi.fn(), getDefaultCompanyGoal: vi.fn(async () => null) },
}));

vi.mock("../services/index.js", () => ({
  issueService: () => readMocks.issues,
  accessService: () => ({}),
  agentService: () => ({}),
  goalService: () => readMocks.goals,
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  projectService: () => readMocks.projects,
  logActivity: vi.fn(async () => undefined),
}));

const { issueRoutes } = await import("../routes/issues.js");

describe("GET /issues/:id hides foreign links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMocks.issues.getById.mockResolvedValue({
      id: "issue-1",
      companyId: COMPANY,
      projectId: "proj-foreign",
      goalId: "goal-foreign",
      title: "mine",
    });
    readMocks.projects.getById.mockResolvedValue({ id: "proj-foreign", companyId: OTHER_COMPANY, name: "secret project" });
    readMocks.goals.getById.mockResolvedValue({ id: "goal-foreign", companyId: OTHER_COMPANY, title: "secret goal" });
  });

  it("returns null project and goal when they belong to another company", async () => {
    const res = await request(appWithActor(ACTORS.member, issueRoutes({} as any, {} as any))).get("/api/issues/issue-1");
    expect(res.status).toBe(200);
    expect(res.body.project).toBeNull();
    expect(res.body.goal).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("returns same-company project and goal", async () => {
    readMocks.projects.getById.mockResolvedValue({ id: "proj-foreign", companyId: COMPANY, name: "own project" });
    readMocks.goals.getById.mockResolvedValue({ id: "goal-foreign", companyId: COMPANY, title: "own goal" });
    const res = await request(appWithActor(ACTORS.member, issueRoutes({} as any, {} as any))).get("/api/issues/issue-1");
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe("own project");
    expect(res.body.goal.title).toBe("own goal");
  });
});
