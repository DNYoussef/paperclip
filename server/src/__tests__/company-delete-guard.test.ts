import type express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies } from "@paperclipai/db";
import { buildApp, send, seedWorld, startRealApp, type RealApp } from "./helpers/real-app.js";

// SEC-066: companyDeletionEnabled gates DELETE /companies/:companyId, and even
// when enabled only an instance admin may hard-delete. The disabled-flag app
// and the enabled-flag app share one real database.

let disabled: RealApp;
let enabled: express.Express;

beforeAll(async () => {
  disabled = await startRealApp({ companyDeletionEnabled: false });
  enabled = await buildApp(disabled.db, { companyDeletionEnabled: true });
}, 120_000);

afterAll(async () => {
  await disabled?.stop();
});

const exists = (id: string) =>
  disabled.db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)).then((r) => r.length === 1);

describe("DELETE /companies/:companyId guard (SEC-066)", () => {
  it("flag false: an authorized member gets 403 and no DB mutation", async () => {
    const w = await seedWorld(disabled.db);
    const res = await send(disabled.app, w.callers.member, "delete", `/api/companies/${w.companyA.id}`);
    expect(res.status).toBe(403);
    expect(await exists(w.companyA.id)).toBe(true);
  });

  it("flag false: an instance admin is refused too", async () => {
    const w = await seedWorld(disabled.db);
    const res = await send(disabled.app, w.callers.instanceAdmin, "delete", `/api/companies/${w.companyA.id}`);
    expect(res.status).toBe(403);
    expect(await exists(w.companyA.id)).toBe(true);
  });

  it("flag true: a non-admin member, an outsider and an agent are still refused", async () => {
    const w = await seedWorld(disabled.db);
    for (const caller of [w.callers.member, w.callers.outsider, w.callers.peerAgent]) {
      const res = await send(enabled, caller, "delete", `/api/companies/${w.companyA.id}`);
      expect(res.status).toBe(403);
    }
    expect(await exists(w.companyA.id)).toBe(true);
  });

  it("flag true: an instance admin deletes", async () => {
    const w = await seedWorld(disabled.db);
    const res = await send(enabled, w.callers.instanceAdmin, "delete", `/api/companies/${w.companyA.id}`);
    expect(res.status).toBe(200);
    expect(await exists(w.companyA.id)).toBe(false);
  });

  it("get-session tells the UI whether the caller is an instance admin", async () => {
    const w = await seedWorld(disabled.db);
    const member = await send(enabled, w.callers.member, "get", "/api/auth/get-session");
    const admin = await send(enabled, w.callers.instanceAdmin, "get", "/api/auth/get-session");
    expect(member.body.user.isInstanceAdmin).toBe(false);
    expect(admin.body.user.isInstanceAdmin).toBe(true);
  });
});
