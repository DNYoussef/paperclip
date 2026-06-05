import { afterEach, describe, expect, it, vi } from "vitest";
import { companyPortabilityService } from "../services/company-portability.js";

function manifestWithCompanyPath(path: string) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-04T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: false },
    company: {
      path,
      name: "Imported Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: false,
    },
    agents: [],
    requiredSecrets: [],
  };
}

describe("company portability remote import security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects private-host manifest URLs before making a network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not run"));
    const service = companyPortabilityService({} as any);

    await expect(
      service.previewImport({
        source: { type: "url", url: "http://169.254.169.254/latest/paperclip.manifest.json" },
        target: { mode: "new_company" },
      }),
    ).rejects.toThrow(/not allowed/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects manifest file paths that try to fetch a private absolute URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(manifestWithCompanyPath("http://127.0.0.1/admin.md")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const service = companyPortabilityService({} as any);

    await expect(
      service.previewImport({
        source: { type: "url", url: "https://example.com/paperclip.manifest.json" },
        target: { mode: "new_company" },
      }),
    ).rejects.toThrow(/relative markdown path/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
