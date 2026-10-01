import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvals,
  heartbeatRuns,
  issues,
  projectGoals,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { send, seedWorld, startRealApp, type RealApp, type World } from "./helpers/real-app.js";

// SEC-062 / SEC-056: records in company A may only reference company A rows.
// Every case uses EXISTING company B rows (never missing ids), runs the real
// routes and services against PostgreSQL, and checks both the response and
// the stored state. Read cases plant deliberately inconsistent links.

let real: RealApp;

beforeAll(async () => {
  real = await startRealApp();
}, 120_000);

afterAll(async () => {
  await real?.stop();
});

const db = () => real.db;
const issueCount = (w: World) =>
  db().select({ id: issues.id }).from(issues).where(eq(issues.companyId, w.companyA.id)).then((r) => r.length);
const projectCount = (w: World) =>
  db().select({ id: projects.id }).from(projects).where(eq(projects.companyId, w.companyA.id)).then((r) => r.length);

describe("issue create/update rejects foreign references", () => {
  for (const ref of ["projectId", "goalId", "parentId"] as const) {
    it(`create with a foreign ${ref} -> 404 and no issue`, async () => {
      const w = await seedWorld(db());
      const foreign = { projectId: w.projectB.id, goalId: w.goalB.id, parentId: w.issueB.id }[ref];
      const before = await issueCount(w);
      const res = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/issues`, {
        title: "probe",
        [ref]: foreign,
      });
      expect(res.status).toBe(404);
      expect(await issueCount(w)).toBe(before);
    });

    it(`update with a foreign ${ref} -> 404 and the stored link is unchanged`, async () => {
      const w = await seedWorld(db());
      const foreign = { projectId: w.projectB.id, goalId: w.goalB.id, parentId: w.issueB.id }[ref];
      const res = await send(real.app, w.callers.member, "patch", `/api/issues/${w.issueA.id}`, { [ref]: foreign });
      expect(res.status).toBe(404);
      const row = await db().select().from(issues).where(eq(issues.id, w.issueA.id)).then((r) => r[0]!);
      expect(row[ref]).toBeNull();
    });
  }

  it("same-company references are accepted by a member and by a same-company agent", async () => {
    const w = await seedWorld(db());
    for (const caller of [w.callers.member, w.callers.peerAgent]) {
      const res = await send(real.app, caller, "post", `/api/companies/${w.companyA.id}/issues`, {
        title: "ok",
        projectId: w.projectA.id,
        goalId: w.goalA.id,
        parentId: w.issueA.id,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ projectId: w.projectA.id, goalId: w.goalA.id, parentId: w.issueA.id });
    }
  });
});

describe("project create/update rejects foreign goals", () => {
  it("create with a foreign goal in goalIds -> 404 and no project", async () => {
    const w = await seedWorld(db());
    const before = await projectCount(w);
    const res = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/projects`, {
      name: "probe",
      goalIds: [w.goalB.id],
    });
    expect(res.status).toBe(404);
    expect(await projectCount(w)).toBe(before);
  });

  it("create with a foreign legacy goalId and an empty goalIds list stores no foreign link", async () => {
    const w = await seedWorld(db());
    const before = await projectCount(w);
    const res = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/projects`, {
      name: "probe",
      goalId: w.goalB.id,
      goalIds: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await projectCount(w)).toBe(before);
    const leaked = await db().select({ id: projects.id }).from(projects).where(eq(projects.goalId, w.goalB.id));
    expect(leaked).toHaveLength(0);
  });

  it("create with a same-company goal stores it in both columns", async () => {
    const w = await seedWorld(db());
    const res = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/projects`, {
      name: "ok",
      goalIds: [w.goalA.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.goalId).toBe(w.goalA.id);
    expect(res.body.goalIds).toEqual([w.goalA.id]);
  });

  it("update with a foreign goal -> 404 and no link row", async () => {
    const w = await seedWorld(db());
    const res = await send(real.app, w.callers.member, "patch", `/api/projects/${w.projectA.id}`, {
      goalIds: [w.goalB.id],
    });
    expect(res.status).toBe(404);
    const links = await db().select().from(projectGoals).where(eq(projectGoals.projectId, w.projectA.id));
    expect(links).toHaveLength(0);
  });
});

describe("read paths never expand stored cross-company links", () => {
  async function plantForeignWorkspace(w: World) {
    return db()
      .insert(projectWorkspaces)
      .values({ companyId: w.companyB.id, projectId: w.projectB.id, name: `ws secret ${w.projectB.id}`, cwd: "/srv/foreign" })
      .returning()
      .then((r) => r[0]!);
  }

  it("GET /issues/:id: a same-company parent that links foreign project and goal discloses neither", async () => {
    const w = await seedWorld(db());
    const ws = await plantForeignWorkspace(w);
    const parent = await db()
      .insert(issues)
      .values({ companyId: w.companyA.id, title: "parent", projectId: w.projectB.id, goalId: w.goalB.id })
      .returning()
      .then((r) => r[0]!);
    const child = await db()
      .insert(issues)
      .values({ companyId: w.companyA.id, title: "child", parentId: parent.id, projectId: w.projectB.id, goalId: w.goalB.id })
      .returning()
      .then((r) => r[0]!);

    const res = await send(real.app, w.callers.member, "get", `/api/issues/${child.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ancestors.map((a: { id: string }) => a.id)).toEqual([parent.id]);
    expect(res.body.ancestors[0].project).toBeNull();
    expect(res.body.ancestors[0].goal).toBeNull();
    expect(res.body.project).toBeNull();
    expect(res.body.goal).toBeNull();
    const text = JSON.stringify(res.body);
    for (const secret of [w.projectB.name, "foreign description", w.goalB.title, ws.name, "/srv/foreign"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("GET /issues/:id: the ancestor walk stops at a foreign parent", async () => {
    const w = await seedWorld(db());
    const child = await db()
      .insert(issues)
      .values({ companyId: w.companyA.id, title: "child", parentId: w.issueB.id })
      .returning()
      .then((r) => r[0]!);
    const res = await send(real.app, w.callers.member, "get", `/api/issues/${child.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ancestors).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(w.issueB.title);
  });

  it("GET /projects/:id: foreign goal links and foreign workspace rows are not expanded", async () => {
    const w = await seedWorld(db());
    // Link rows that claim company A but point at company B's goal, and a
    // link row stamped with company B: both inconsistent with the project.
    await db().insert(projectGoals).values({ projectId: w.projectA.id, goalId: w.goalB.id, companyId: w.companyA.id });
    await db().insert(projectGoals).values({ projectId: w.projectA.id, goalId: w.goalA.id, companyId: w.companyB.id });
    await db()
      .insert(projectWorkspaces)
      .values({ companyId: w.companyB.id, projectId: w.projectA.id, name: "ws secret foreign", cwd: "/srv/foreign" });

    const res = await send(real.app, w.callers.member, "get", `/api/projects/${w.projectA.id}`);
    expect(res.status).toBe(200);
    expect(res.body.goalIds).toEqual([]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(w.goalB.title);
    expect(text).not.toContain("ws secret foreign");
  });

  it("GET /companies/:companyId/costs/by-project never names a foreign project", async () => {
    const w = await seedWorld(db());
    const run = await db()
      .insert(heartbeatRuns)
      .values({ companyId: w.companyA.id, agentId: w.agentA.id, status: "succeeded", finishedAt: new Date(), usageJson: { costUsd: 1.5 } })
      .returning()
      .then((r) => r[0]!);
    const linked = await db()
      .insert(issues)
      .values({ companyId: w.companyA.id, title: "costed", projectId: w.projectB.id })
      .returning()
      .then((r) => r[0]!);
    await db().insert(activityLog).values({
      companyId: w.companyA.id,
      actorType: "agent",
      actorId: w.agentA.id,
      action: "issue.updated",
      entityType: "issue",
      entityId: linked.id,
      runId: run.id,
    });
    const res = await send(real.app, w.callers.member, "get", `/api/companies/${w.companyA.id}/costs/by-project`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(w.projectB.name);
  });
});

describe("approval agent targets stay inside the approval company (SEC-056)", () => {
  const agentState = (id: string) =>
    db().select({ status: agents.status }).from(agents).where(eq(agents.id, id)).then((r) => r[0]!.status);
  const liveKeys = (agentId: string) =>
    db()
      .select({ id: agentApiKeys.id, revokedAt: agentApiKeys.revokedAt })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, agentId))
      .then((rows) => rows.filter((row) => row.revokedAt === null).length);
  const approvalCount = (w: World) =>
    db().select({ id: approvals.id }).from(approvals).where(eq(approvals.companyId, w.companyA.id)).then((r) => r.length);

  it("create with a foreign payload.agentId or requestedByAgentId -> 404 and nothing stored", async () => {
    const w = await seedWorld(db());
    const before = await approvalCount(w);
    const foreignTarget = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/approvals`, {
      type: "hire_agent",
      payload: { agentId: w.agentB.id, name: "x" },
    });
    const foreignRequester = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/approvals`, {
      type: "approve_ceo_strategy",
      requestedByAgentId: w.agentB.id,
      payload: {},
    });
    expect(foreignTarget.status).toBe(404);
    expect(foreignRequester.status).toBe(404);
    expect(await approvalCount(w)).toBe(before);
  });

  it("an agent may only name itself as requester", async () => {
    const w = await seedWorld(db());
    const before = await approvalCount(w);
    const other = await send(real.app, w.callers.peerAgent, "post", `/api/companies/${w.companyA.id}/approvals`, {
      type: "approve_ceo_strategy",
      requestedByAgentId: w.agentA.id,
      payload: {},
    });
    expect(other.status).toBe(403);
    expect(await approvalCount(w)).toBe(before);

    for (const body of [
      { type: "approve_ceo_strategy", requestedByAgentId: w.peerA.id, payload: {} },
      { type: "approve_ceo_strategy", payload: {} },
    ]) {
      const res = await send(real.app, w.callers.peerAgent, "post", `/api/companies/${w.companyA.id}/approvals`, body);
      expect(res.status).toBe(201);
      expect(res.body.requestedByAgentId).toBe(w.peerA.id);
    }
  });

  it("a board member may name any agent of the same company as requester", async () => {
    const w = await seedWorld(db());
    const res = await send(real.app, w.callers.member, "post", `/api/companies/${w.companyA.id}/approvals`, {
      type: "approve_ceo_strategy",
      requestedByAgentId: w.agentA.id,
      payload: {},
    });
    expect(res.status).toBe(201);
    expect(res.body.requestedByAgentId).toBe(w.agentA.id);
  });

  it("rejecting a stored approval that targets a foreign agent leaves that agent and its keys alone", async () => {
    const w = await seedWorld(db());
    const planted = await db()
      .insert(approvals)
      .values({ companyId: w.companyA.id, type: "hire_agent", status: "pending", payload: { agentId: w.agentB.id } })
      .returning()
      .then((r) => r[0]!);
    const res = await send(real.app, w.callers.member, "post", `/api/approvals/${planted.id}/reject`, {});
    expect(res.status).toBe(404);
    expect(await agentState(w.agentB.id)).toBe("idle");
    expect(await liveKeys(w.agentB.id)).toBe(1);
    const row = await db().select().from(approvals).where(eq(approvals.id, planted.id)).then((r) => r[0]!);
    expect(row.status).toBe("pending");
  });

  it("approving a stored approval with a foreign requester does not resolve or wake it", async () => {
    const w = await seedWorld(db());
    const planted = await db()
      .insert(approvals)
      .values({ companyId: w.companyA.id, type: "approve_ceo_strategy", status: "pending", payload: {}, requestedByAgentId: w.agentB.id })
      .returning()
      .then((r) => r[0]!);
    const res = await send(real.app, w.callers.member, "post", `/api/approvals/${planted.id}/approve`, {});
    expect(res.status).toBe(404);
    const row = await db().select().from(approvals).where(eq(approvals.id, planted.id)).then((r) => r[0]!);
    expect(row.status).toBe("pending");
  });

  it("resubmitting with a foreign payload.agentId -> 404 and the payload is unchanged", async () => {
    const w = await seedWorld(db());
    const planted = await db()
      .insert(approvals)
      .values({ companyId: w.companyA.id, type: "hire_agent", status: "revision_requested", payload: { name: "x" } })
      .returning()
      .then((r) => r[0]!);
    const res = await send(real.app, w.callers.member, "post", `/api/approvals/${planted.id}/resubmit`, {
      payload: { agentId: w.agentB.id },
    });
    expect(res.status).toBe(404);
    const row = await db().select().from(approvals).where(eq(approvals.id, planted.id)).then((r) => r[0]!);
    expect(row).toMatchObject({ status: "revision_requested", payload: { name: "x" } });
  });

  it("rejecting a same-company hire terminates that agent and revokes its keys", async () => {
    const w = await seedWorld(db());
    await db().update(agents).set({ status: "pending_approval" }).where(eq(agents.id, w.peerA.id));
    const approval = await db()
      .insert(approvals)
      .values({ companyId: w.companyA.id, type: "hire_agent", status: "pending", payload: { agentId: w.peerA.id } })
      .returning()
      .then((r) => r[0]!);
    const res = await send(real.app, w.callers.member, "post", `/api/approvals/${approval.id}/reject`, {});
    expect(res.status).toBe(200);
    expect(await agentState(w.peerA.id)).toBe("terminated");
    expect(await liveKeys(w.peerA.id)).toBe(0);
    // The foreign agent is untouched.
    expect(await liveKeys(w.agentB.id)).toBe(1);
    const otherKeys = await db()
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.agentId, w.agentA.id)));
    expect(otherKeys.every((k) => k.revokedAt === null)).toBe(true);
  });
});

describe("run links stay inside the issue company (SEC-056)", () => {
  const runStatus = (id: string) =>
    db().select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((r) => r[0]!.status);
  const foreignRun = (w: World) =>
    db()
      .insert(heartbeatRuns)
      .values({ companyId: w.companyB.id, agentId: w.agentB.id, status: "running" })
      .returning()
      .then((r) => r[0]!);
  const issueRunLinks = (id: string) =>
    db()
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, id))
      .then((r) => r[0]!);

  it("checkout with a foreign run id header is refused and stores no run link", async () => {
    const w = await seedWorld(db());
    const runB = await foreignRun(w);
    await db().update(issues).set({ assigneeAgentId: w.agentA.id, status: "todo" }).where(eq(issues.id, w.issueA.id));
    const res = await send(
      real.app,
      w.callers.targetAgent,
      "post",
      `/api/issues/${w.issueA.id}/checkout`,
      { agentId: w.agentA.id, expectedStatuses: ["todo"] },
      { "x-paperclip-run-id": runB.id },
    );
    expect(res.status).toBe(401);
    expect(await issueRunLinks(w.issueA.id)).toEqual({ checkoutRunId: null, executionRunId: null });
  });

  it("checkout with the agent's own run id stores that run", async () => {
    const w = await seedWorld(db());
    await db().update(issues).set({ assigneeAgentId: w.agentA.id, status: "todo" }).where(eq(issues.id, w.issueA.id));
    const res = await send(
      real.app,
      w.callers.targetAgent,
      "post",
      `/api/issues/${w.issueA.id}/checkout`,
      { agentId: w.agentA.id, expectedStatuses: ["todo"] },
      { "x-paperclip-run-id": w.runA.id },
    );
    expect(res.status).toBe(200);
    expect(await issueRunLinks(w.issueA.id)).toEqual({ checkoutRunId: w.runA.id, executionRunId: w.runA.id });
  });

  it("a peer agent's run id is not accepted as the caller's own", async () => {
    const w = await seedWorld(db());
    await db().update(issues).set({ assigneeAgentId: w.peerA.id, status: "todo" }).where(eq(issues.id, w.issueA.id));
    const res = await send(
      real.app,
      w.callers.peerAgent,
      "post",
      `/api/issues/${w.issueA.id}/checkout`,
      { agentId: w.peerA.id, expectedStatuses: ["todo"] },
      { "x-paperclip-run-id": w.runA.id },
    );
    expect(res.status).toBe(401);
    expect(await issueRunLinks(w.issueA.id)).toEqual({ checkoutRunId: null, executionRunId: null });
  });

  it("a stored foreign run link is neither disclosed nor cancelled", async () => {
    const w = await seedWorld(db());
    const runB = await foreignRun(w);
    await db().update(issues).set({ executionRunId: runB.id, status: "in_progress" }).where(eq(issues.id, w.issueA.id));

    const active = await send(real.app, w.callers.member, "get", `/api/issues/${w.issueA.id}/active-run`);
    expect(active.status).toBe(200);
    expect(active.body).toBeNull();

    const list = await send(real.app, w.callers.member, "get", `/api/companies/${w.companyA.id}/issues`);
    expect(list.status).toBe(200);
    const listed = list.body.find((row: { id: string }) => row.id === w.issueA.id);
    expect(listed.activeRun ?? null).toBeNull();

    const comment = await send(real.app, w.callers.member, "post", `/api/issues/${w.issueA.id}/comments`, {
      body: "stop",
      interrupt: true,
    });
    expect(comment.status).toBe(201);
    expect(await runStatus(runB.id)).toBe("running");
  });

  it("a same-company run link is shown and can be interrupted", async () => {
    const w = await seedWorld(db());
    await db().update(issues).set({ executionRunId: w.runA.id, status: "in_progress" }).where(eq(issues.id, w.issueA.id));
    const active = await send(real.app, w.callers.member, "get", `/api/issues/${w.issueA.id}/active-run`);
    expect(active.body?.id).toBe(w.runA.id);
    const comment = await send(real.app, w.callers.member, "post", `/api/issues/${w.issueA.id}/comments`, {
      body: "stop",
      interrupt: true,
    });
    expect(comment.status).toBe(201);
    expect(await runStatus(w.runA.id)).toBe("cancelled");
  });
});

describe("workspace endpoints require the owning project's company (SEC-062)", () => {
  async function plantForeignRowUnderProjectA(w: World) {
    // Inconsistent stored row: company B's workspace pointing at project A.
    return db()
      .insert(projectWorkspaces)
      .values({ companyId: w.companyB.id, projectId: w.projectA.id, name: "ws secret foreign", cwd: "/srv/foreign" })
      .returning()
      .then((r) => r[0]!);
  }
  const wsRow = (id: string) =>
    db().select().from(projectWorkspaces).where(eq(projectWorkspaces.id, id)).then((r) => r[0] ?? null);

  it("GET lists, PATCH and DELETE never reach a foreign workspace row", async () => {
    const w = await seedWorld(db());
    const foreign = await plantForeignRowUnderProjectA(w);

    const list = await send(real.app, w.callers.member, "get", `/api/projects/${w.projectA.id}/workspaces`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("ws secret foreign");

    const patch = await send(real.app, w.callers.member, "patch", `/api/projects/${w.projectA.id}/workspaces/${foreign.id}`, {
      name: "hijacked",
    });
    expect(patch.status).toBe(404);
    const del = await send(real.app, w.callers.member, "delete", `/api/projects/${w.projectA.id}/workspaces/${foreign.id}`);
    expect(del.status).toBe(404);
    expect(await wsRow(foreign.id)).toMatchObject({ name: "ws secret foreign", companyId: w.companyB.id });
  });

  it("same-company workspaces are listed, updated and deleted", async () => {
    const w = await seedWorld(db());
    await plantForeignRowUnderProjectA(w);
    const created = await send(real.app, w.callers.member, "post", `/api/projects/${w.projectA.id}/workspaces`, {
      name: "own",
      cwd: "/srv/own",
    });
    expect(created.status).toBe(201);
    const list = await send(real.app, w.callers.member, "get", `/api/projects/${w.projectA.id}/workspaces`);
    expect(list.body.map((x: { id: string }) => x.id)).toEqual([created.body.id]);
    const patch = await send(real.app, w.callers.member, "patch", `/api/projects/${w.projectA.id}/workspaces/${created.body.id}`, {
      name: "renamed",
    });
    expect(patch.status).toBe(200);
    expect((await wsRow(created.body.id))?.name).toBe("renamed");
    const del = await send(real.app, w.callers.member, "delete", `/api/projects/${w.projectA.id}/workspaces/${created.body.id}`);
    expect(del.status).toBe(200);
    expect(await wsRow(created.body.id)).toBeNull();
  });
});

describe("wakeup coalescing never follows a foreign run link (SEC-056)", () => {
  const runRow = (id: string) =>
    db().select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((r) => r[0]!);

  it("a stored foreign execution link is cleared, not coalesced into, disclosed or mutated", async () => {
    const w = await seedWorld(db());
    const runB = await db()
      .insert(heartbeatRuns)
      .values({ companyId: w.companyB.id, agentId: w.agentB.id, status: "running", contextSnapshot: { secret: "company B output" } })
      .returning()
      .then((r) => r[0]!);
    await db()
      .update(issues)
      .set({ executionRunId: runB.id, executionAgentNameKey: w.agentA.name.toLowerCase(), status: "in_progress" })
      .where(eq(issues.id, w.issueA.id));

    const res = await send(real.app, w.callers.member, "post", `/api/agents/${w.agentA.id}/wakeup`, {
      payload: { issueId: w.issueA.id },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.body?.id).not.toBe(runB.id);
    expect(JSON.stringify(res.body)).not.toContain("company B output");
    expect((await runRow(runB.id)).contextSnapshot).toEqual({ secret: "company B output" });
    const issue = await db().select().from(issues).where(eq(issues.id, w.issueA.id)).then((r) => r[0]!);
    expect(issue.executionRunId).not.toBe(runB.id);
  });

  it("control: a same-company execution link is coalesced", async () => {
    const w = await seedWorld(db());
    await db()
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: w.issueA.id } })
      .where(eq(heartbeatRuns.id, w.runA.id));
    await db()
      .update(issues)
      .set({ executionRunId: w.runA.id, executionAgentNameKey: w.agentA.name.toLowerCase(), status: "in_progress" })
      .where(eq(issues.id, w.issueA.id));
    const res = await send(real.app, w.callers.member, "post", `/api/agents/${w.agentA.id}/wakeup`, {
      payload: { issueId: w.issueA.id },
    });
    expect(res.status).toBe(202);
    expect(res.body.id).toBe(w.runA.id);
    expect((await runRow(w.runA.id)).contextSnapshot).toMatchObject({ issueId: w.issueA.id });
  });
});
