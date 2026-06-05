import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  createInviteToken,
  INVITE_TOKEN_ENTROPY_BITS,
  INVITE_TOKEN_SUFFIX_LENGTH,
} from "../routes/access.js";
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";
import { publishLiveEvent } from "../services/live-events.js";

describe("phase 5 Paperclip claim-control tail", () => {
  it("labels external secret providers unavailable and keeps their operations fail-closed", async () => {
    const providers = listSecretProviders();
    const local = providers.find((provider) => provider.id === "local_encrypted");
    expect(local).toMatchObject({
      status: "available",
      selectable: true,
      evidenceStatus: "shipped_provider",
    });

    for (const id of ["aws_secrets_manager", "gcp_secret_manager", "vault"] as const) {
      const descriptor = providers.find((provider) => provider.id === id);
      expect(descriptor).toMatchObject({
        requiresExternalRef: true,
        status: "unavailable",
        selectable: false,
        evidenceStatus: "not_shipped_external_provider",
      });
      expect(descriptor?.unavailableReason).toMatch(/not shipped|not configured/i);

      const provider = getSecretProvider(id);
      await expect(provider.createVersion({ value: "secret", externalRef: "ref" })).rejects.toMatchObject({
        status: 422,
      } satisfies Partial<HttpError>);
      await expect(provider.resolveVersion({ material: {}, externalRef: "ref" })).rejects.toMatchObject({
        status: 422,
      } satisfies Partial<HttpError>);
    }
  });

  it("uses restart-safe UUIDs for live events instead of a module-level counter", () => {
    const first = publishLiveEvent({
      companyId: "company-1",
      type: "activity.logged",
      payload: { message: "first" },
    });
    const second = publishLiveEvent({
      companyId: "company-1",
      type: "activity.logged",
      payload: { message: "second" },
    });

    expect(typeof first.id).toBe("string");
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.id).not.toBe(second.id);
    expect(Number.isInteger(first.id)).toBe(false);
  });

  it("generates high-entropy invite tokens with an unbiased suffix alphabet", () => {
    expect(INVITE_TOKEN_SUFFIX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(INVITE_TOKEN_ENTROPY_BITS).toBeGreaterThanOrEqual(120);

    const tokens = new Set<string>();
    for (let idx = 0; idx < 64; idx += 1) {
      const token = createInviteToken();
      expect(token).toMatch(new RegExp(`^pcp_invite_[a-z0-9]{${INVITE_TOKEN_SUFFIX_LENGTH}}$`));
      tokens.add(token);
    }
    expect(tokens.size).toBe(64);
  });
});
