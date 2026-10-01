import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog } from "@paperclipai/db";
import { send, seedWorld, startRealApp, type RealApp, type World } from "./helpers/real-app.js";

// SEC-056 (grown): GET /api/heartbeat-runs/:runId/issues authenticates (401),
// authorizes against the run's company, and joins only that company's issues.

let real: RealApp;

beforeAll(async () => {
  real = await startRealApp();
}, 120_000);

afterAll(async () => {
  await real?.stop();
});

async function worldWithRunActivity() {
  const w = await seedWorld(real.db);
  // The run touched issue A; a corrupt row in company A also points at
  // company B's issue. Neither may leak to an unauthorized caller, and the
  // foreign issue may never be returned at all.
  await real.db.insert(activityLog).values([
    { companyId: w.companyA.id, actorType: "agent", actorId: w.agentA.id, action: "issue.updated", entityType: "issue", entityId: w.issueA.id, runId: w.runA.id },
    { companyId: w.companyA.id, actorType: "agent", actorId: w.agentA.id, action: "issue.updated", entityType: "issue", entityId: w.issueB.id, runId: w.runA.id },
  ]);
  return w;
}

const path = (w: World) => `/api/heartbeat-runs/${w.runA.id}/issues`;

describe("GET /heartbeat-runs/:runId/issues authorization", () => {
  it("anonymous caller gets 401 and no issue metadata", async () => {
    const w = await worldWithRunActivity();
    const res = await send(real.app, w.callers.anonymous, "get", path(w));
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(w.issueA.title);
  });

  it("anonymous caller gets 401 even for an unknown run", async () => {
    const res = await send(real.app, { kind: "anonymous" }, "get", "/api/heartbeat-runs/00000000-0000-4000-8000-000000000000/issues");
    expect(res.status).toBe(401);
  });

  it("outsider, former member and foreign agent get 403 and no issue metadata", async () => {
    const w = await worldWithRunActivity();
    for (const caller of [w.callers.outsider, w.callers.formerMember, w.callers.foreignAgent]) {
      const res = await send(real.app, caller, "get", path(w));
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(w.issueA.title);
    }
  });

  it("member gets 404 for an unknown run", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "get", "/api/heartbeat-runs/00000000-0000-4000-8000-000000000000/issues");
    expect(res.status).toBe(404);
  });

  it("member and same-company agent read the run's own-company issues only", async () => {
    const w = await worldWithRunActivity();
    for (const caller of [w.callers.member, w.callers.peerAgent]) {
      const res = await send(real.app, caller, "get", path(w));
      expect(res.status).toBe(200);
      expect(res.body.map((row: { issueId: string }) => row.issueId)).toEqual([w.issueA.id]);
      expect(JSON.stringify(res.body)).not.toContain(w.issueB.title);
    }
  });
});
