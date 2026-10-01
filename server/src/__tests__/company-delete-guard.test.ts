import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { ACTORS, COMPANY, appWithActor } from "./helpers/route-actors.js";

// SEC-066: companyDeletionEnabled must gate DELETE /companies/:companyId,
// and even when enabled only an instance admin may hard-delete.
const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(async (id: string) => ({ id })),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
  companyPortabilityService: () => ({}),
  accessService: () => ({ ensureMembership: vi.fn() }),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/live-events.js", () => ({
  closeLiveEventsConnections: vi.fn(),
}));

function app(actor: (typeof ACTORS)[keyof typeof ACTORS], companyDeletionEnabled: boolean) {
  return appWithActor(actor, companyRoutes({} as any, { companyDeletionEnabled }), "/api/companies");
}

describe("DELETE /companies/:companyId guard (SEC-066)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flag false: an authorized member gets 403 and no DB mutation", async () => {
    const res = await request(app(ACTORS.member, false)).delete(`/api/companies/${COMPANY}`);
    expect(res.status).toBe(403);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("flag false: an instance admin is refused too", async () => {
    const res = await request(app(ACTORS.instanceAdmin, false)).delete(`/api/companies/${COMPANY}`);
    expect(res.status).toBe(403);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("flag true: a non-admin member is still refused", async () => {
    const res = await request(app(ACTORS.member, true)).delete(`/api/companies/${COMPANY}`);
    expect(res.status).toBe(403);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("flag true: an outsider is refused", async () => {
    const res = await request(app(ACTORS.outsider, true)).delete(`/api/companies/${COMPANY}`);
    expect(res.status).toBe(403);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("flag true: an instance admin deletes", async () => {
    const res = await request(app(ACTORS.instanceAdmin, true)).delete(`/api/companies/${COMPANY}`);
    expect(res.status).toBe(200);
    expect(mockCompanyService.remove).toHaveBeenCalledWith(COMPANY);
  });

  it("omitted options default to deletion disabled", async () => {
    const res = await request(
      appWithActor(ACTORS.instanceAdmin, companyRoutes({} as any), "/api/companies"),
    ).delete(`/api/companies/${COMPANY}`);
    expect(res.status).toBe(403);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });
});
