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
    const executionSource = readService("heartbeat-execution.ts");

    expect(heartbeatSource.split(/\r?\n/).length).toBeLessThan(2050);
    expect(heartbeatSource).toContain('from "./heartbeat-capacity.js"');
    expect(heartbeatSource).toContain('from "./heartbeat-session.js"');
    expect(heartbeatSource).toContain('from "./heartbeat-execution.js"');
    expect(heartbeatSource).not.toContain("const defaultSessionCodec");
    expect(heartbeatSource).not.toContain("select id from agents where id");
    expect(heartbeatSource).not.toContain("function mergeCoalescedContextSnapshot");
    expect(heartbeatSource).not.toContain("handle = await runLogStore.begin");
    expect(heartbeatSource).not.toContain("getServerAdapter(agent.adapterType)");
    expect(heartbeatSource).not.toContain("persistAdapterManagedRuntimeServices");
    expect(capacitySource).toContain("select id from agents where id");
    expect(capacitySource).toContain("export async function claimQueuedHeartbeatRunForCapacity");
    expect(sessionSource).toContain("export function mergeCoalescedContextSnapshot");
    expect(sessionSource).toContain("export function resolveNextSessionState");
    expect(executionSource).toContain("export async function runPreparedAdapterExecution");
    expect(executionSource).toContain("handle = await runLogStore.begin");
    expect(executionSource).toContain("getServerAdapter(agent.adapterType)");
    expect(executionSource).toContain("persistAdapterManagedRuntimeServices");
  });

  it("keeps executeRun as an orchestrator with extracted setup and execution", () => {
    const heartbeatSource = readService("heartbeat.ts");

    expect(heartbeatSource).toContain("async function prepareExecutionContextForRun");
    expect(heartbeatSource).toContain("prepareExecutionContextForRun(run, agent)");
    expect(heartbeatSource).toContain("runPreparedAdapterExecution({");
    expect(heartbeatSource).not.toContain("let stdoutExcerpt");
    expect(heartbeatSource).not.toContain("const onAdapterMeta");
    expect(
      functionSpanLines(
        heartbeatSource,
        "  async function executeRun(runId: string)",
        "  async function releaseIssueExecutionAndPromote",
      ),
    ).toBeLessThan(140);
  });
});
