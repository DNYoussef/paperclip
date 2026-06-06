import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const servicesDir = path.resolve(__dirname, "../services");

function readService(name: string) {
  return fs.readFileSync(path.join(servicesDir, name), "utf8");
}

function functionSpanLines(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).split(/\r?\n/).length;
}

describe("heartbeat service structure", () => {
  it("keeps session/context helper ownership outside the heartbeat god module", () => {
    const heartbeatSource = readService("heartbeat.ts");
    const capacitySource = readService("heartbeat-capacity.ts");
    const sessionSource = readService("heartbeat-session.ts");

    expect(heartbeatSource.split(/\r?\n/).length).toBeLessThan(2400);
    expect(heartbeatSource).toContain('from "./heartbeat-capacity.js"');
    expect(heartbeatSource).toContain('from "./heartbeat-session.js"');
    expect(heartbeatSource).not.toContain("const defaultSessionCodec");
    expect(heartbeatSource).not.toContain("select id from agents where id");
    expect(heartbeatSource).not.toContain("function mergeCoalescedContextSnapshot");
    expect(capacitySource).toContain("select id from agents where id");
    expect(capacitySource).toContain("export async function claimQueuedHeartbeatRunForCapacity");
    expect(sessionSource).toContain("export function mergeCoalescedContextSnapshot");
    expect(sessionSource).toContain("export function resolveNextSessionState");
  });

  it("keeps executeRun as an orchestrator with extracted setup", () => {
    const heartbeatSource = readService("heartbeat.ts");

    expect(heartbeatSource).toContain("async function prepareExecutionContextForRun");
    expect(heartbeatSource).toContain("prepareExecutionContextForRun(run, agent)");
    expect(
      functionSpanLines(
        heartbeatSource,
        "  async function executeRun(runId: string)",
        "  async function releaseIssueExecutionAndPromote",
      ),
    ).toBeLessThan(540);
  });
});
