import { afterEach, describe, expect, it } from "vitest";
import { resolveBetterAuthSecret } from "../auth/better-auth.js";

const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
const ORIGINAL_AGENT_JWT_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET;

function restoreEnv() {
  if (ORIGINAL_BETTER_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_BETTER_AUTH_SECRET;
  if (ORIGINAL_AGENT_JWT_SECRET === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  else process.env.PAPERCLIP_AGENT_JWT_SECRET = ORIGINAL_AGENT_JWT_SECRET;
}

describe("Better Auth secret resolution", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("fails closed instead of falling back to the old hardcoded dev secret", () => {
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;

    expect(() => resolveBetterAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("uses configured secrets only", () => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.BETTER_AUTH_SECRET = "configured-secret-value";

    expect(resolveBetterAuthSecret()).toBe("configured-secret-value");
  });
});
