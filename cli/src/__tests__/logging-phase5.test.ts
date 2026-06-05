import { describe, expect, it } from "vitest";
import { LOGGING_MODE_OPTIONS } from "../prompts/logging.js";

describe("phase 5 logging prompt claim control", () => {
  it("does not offer cloud logging as a selectable mode until it is shipped", () => {
    expect(LOGGING_MODE_OPTIONS).toEqual([
      { value: "file", label: "File-based logging", hint: "recommended" },
    ]);
    expect(LOGGING_MODE_OPTIONS.map((option) => option.value)).not.toContain("cloud");
  });
});
