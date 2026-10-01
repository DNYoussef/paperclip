import { describe, expect, it } from "vitest";
import { canDeleteCompanies } from "./company-deletion";

const enabled = { status: "ok" as const, features: { companyDeletionEnabled: true } };
const disabled = { status: "ok" as const, features: { companyDeletionEnabled: false } };

function session(isInstanceAdmin: boolean) {
  return {
    session: { id: "s", userId: "u" },
    user: { id: "u", email: null, name: null, isInstanceAdmin },
  };
}

describe("canDeleteCompanies", () => {
  it("shows delete to an instance admin when the flag is on", () => {
    expect(canDeleteCompanies(enabled, session(true))).toBe(true);
  });

  it("hides delete from an ordinary member even when the flag is on", () => {
    expect(canDeleteCompanies(enabled, session(false))).toBe(false);
  });

  it("hides delete from an admin when the flag is off", () => {
    expect(canDeleteCompanies(disabled, session(true))).toBe(false);
  });

  it("hides delete while health or session is unknown", () => {
    expect(canDeleteCompanies(undefined, session(true))).toBe(false);
    expect(canDeleteCompanies(enabled, null)).toBe(false);
  });
});
