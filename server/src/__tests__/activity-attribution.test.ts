import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog } from "@paperclipai/db";
import { send, seedWorld, startRealApp, type RealApp, type World } from "./helpers/real-app.js";

// SEC-071: client-reported activity is attributed to the authenticated actor,
// reserved server action names are refused, and the entity must belong to the
// path company. Every refusal asserts nothing was persisted.

let real: RealApp;

beforeAll(async () => {
  real = await startRealApp();
}, 120_000);

afterAll(async () => {
  await real?.stop();
});

const url = (w: World) => `/api/companies/${w.companyA.id}/activity`;
const rowsFor = (w: World) => real.db.select().from(activityLog).where(eq(activityLog.companyId, w.companyA.id));

describe("POST /companies/:companyId/activity attribution (SEC-071)", () => {
  it("rejects a body that supplies actorId or actorType", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "post", url(w), {
      actorType: "system",
      actorId: "victim-user",
      action: "client.note",
      entityType: "issue",
      entityId: w.issueA.id,
    });
    expect(res.status).toBe(400);
    expect(await rowsFor(w)).toHaveLength(0);
  });

  it("rejects reserved server action names", async () => {
    const w = await seedWorld(real.db);
    for (const action of ["approval.approved", "company.deleted", "agent.terminated"]) {
      const res = await send(real.app, w.callers.member, "post", url(w), {
        action,
        entityType: "issue",
        entityId: w.issueA.id,
      });
      expect(res.status).toBe(400);
    }
    expect(await rowsFor(w)).toHaveLength(0);
  });

  it("rejects an existing entity owned by another company", async () => {
    const w = await seedWorld(real.db);
    for (const [entityType, entityId] of [
      ["issue", w.issueB.id],
      ["agent", w.agentB.id],
      ["project", w.projectB.id],
      ["goal", w.goalB.id],
      ["company", w.companyB.id],
    ]) {
      const res = await send(real.app, w.callers.member, "post", url(w), { action: "client.note", entityType, entityId });
      expect({ entityType, status: res.status }).toEqual({ entityType, status: 404 });
    }
    expect(await rowsFor(w)).toHaveLength(0);
  });

  it("rejects an unknown entity type", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "post", url(w), {
      action: "client.note",
      entityType: "secret",
      entityId: "secret-1",
    });
    expect(res.status).toBe(400);
    expect(await rowsFor(w)).toHaveLength(0);
  });

  it("anonymous, outsider and former member are refused", async () => {
    const w = await seedWorld(real.db);
    const body = { action: "client.note", entityType: "company", entityId: w.companyA.id };
    expect((await send(real.app, w.callers.anonymous, "post", url(w), body)).status).toBe(401);
    expect((await send(real.app, w.callers.outsider, "post", url(w), body)).status).toBe(403);
    expect((await send(real.app, w.callers.formerMember, "post", url(w), body)).status).toBe(403);
    expect(await rowsFor(w)).toHaveLength(0);
  });

  it("persists the authenticated actor, never the body", async () => {
    const w = await seedWorld(real.db);
    const res = await send(real.app, w.callers.member, "post", url(w), {
      action: "client.note",
      entityType: "issue",
      entityId: w.issueA.id,
      details: { text: "hello" },
    });
    expect(res.status).toBe(201);
    const rows = await rowsFor(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "user",
      actorId: w.users.member,
      action: "client.note",
      entityType: "issue",
      entityId: w.issueA.id,
      agentId: null,
    });
  });
});
