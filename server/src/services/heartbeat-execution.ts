import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec } from "../adapters/index.js";
import { getServerAdapter } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { appendWithCap, asBoolean, MAX_EXCERPT_BYTES, parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { publishLiveEvent } from "./live-events.js";
import type { RunLogHandle } from "./run-log-store.js";
import {
  buildWorkspaceReadyComment,
  type ExecutionWorkspaceIssueRef,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
} from "./workspace-runtime.js";
import {
  readNonEmptyString,
  resolveNextSessionState,
} from "./heartbeat-session.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

type RunLogStore = {
  begin(input: {
    companyId: string;
    agentId: string;
    runId: string;
  }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    input: {
      stream: "stdout" | "stderr";
      chunk: string;
      ts: string;
    },
  ): Promise<void>;
  finalize(handle: RunLogHandle): Promise<{
    bytes: number;
    sha256?: string;
    compressed: boolean;
  }>;
};

type IssuesService = {
  addComment(issueId: string, body: string, opts: { agentId: string }): Promise<unknown>;
};

export type PreparedExecutionContext = {
  context: Record<string, unknown>;
  taskKey: string | null;
  taskSession: unknown;
  previousSessionParams: Record<string, unknown> | null;
  previousSessionDisplayId: string | null;
  sessionCodec: AdapterSessionCodec;
  issueId: string | null;
  issueRef: ExecutionWorkspaceIssueRef | null;
  executionWorkspace: Record<string, any>;
  runtimeWorkspaceWarnings: string[];
  resolvedConfig: Record<string, unknown>;
  secretKeys: Set<string>;
  runtimeForAdapter: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    taskKey: string | null;
  };
};

type RunOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

type ExecutionDeps = {
  db: Db;
  runLogStore: RunLogStore;
  issuesSvc: IssuesService;
  getRun(runId: string): Promise<HeartbeatRun | null>;
  setRunStatus(
    runId: string,
    status: HeartbeatRun["status"],
    patch: Record<string, unknown>,
  ): Promise<HeartbeatRun | null>;
  setWakeupStatus(
    wakeupRequestId: string | null,
    status: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  appendRunEvent(
    run: HeartbeatRun,
    seq: number,
    event: Record<string, unknown>,
  ): Promise<void>;
  releaseIssueExecutionAndPromote(run: HeartbeatRun): Promise<void>;
  updateRuntimeState(
    agent: Agent,
    run: HeartbeatRun,
    result: AdapterExecutionResult,
    opts: { legacySessionId: string | null },
  ): Promise<void>;
  clearTaskSessions(
    companyId: string,
    agentId: string,
    opts: { taskKey: string; adapterType: string },
  ): Promise<unknown>;
  upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string;
    lastError: string | null;
  }): Promise<unknown>;
  finalizeAgentStatus(agentId: string, outcome: RunOutcome): Promise<void>;
};

type ExecutionInput = ExecutionDeps & {
  runId: string;
  run: HeartbeatRun;
  agent: Agent;
  prepared: PreparedExecutionContext;
};

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function adapterOutcome(run: HeartbeatRun | null, result: AdapterExecutionResult): RunOutcome {
  if (run?.status === "cancelled") return "cancelled";
  if (result.timedOut) return "timed_out";
  if ((result.exitCode ?? 0) === 0 && !result.errorMessage) return "succeeded";
  return "failed";
}

function statusForOutcome(outcome: RunOutcome): HeartbeatRun["status"] {
  if (outcome === "succeeded") return "succeeded";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "timed_out") return "timed_out";
  return "failed";
}

function usageJsonForResult(result: AdapterExecutionResult) {
  return result.usage || result.costUsd != null
    ? ({
        ...(result.usage ?? {}),
        ...(result.costUsd != null ? { costUsd: result.costUsd } : {}),
        ...(result.billingType ? { billingType: result.billingType } : {}),
      } as Record<string, unknown>)
    : null;
}

export async function runPreparedAdapterExecution(input: ExecutionInput) {
  const {
    db,
    runId,
    agent,
    prepared,
    runLogStore,
    issuesSvc,
    getRun,
    setRunStatus,
    setWakeupStatus,
    appendRunEvent,
    releaseIssueExecutionAndPromote,
    updateRuntimeState,
    clearTaskSessions,
    upsertTaskSession,
    finalizeAgentStatus,
  } = input;
  let { run } = input;
  const {
    context,
    taskKey,
    taskSession,
    previousSessionParams,
    previousSessionDisplayId,
    sessionCodec,
    issueId,
    issueRef,
    executionWorkspace,
    runtimeWorkspaceWarnings,
    resolvedConfig,
    secretKeys,
    runtimeForAdapter,
  } = prepared;

  let seq = 1;
  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";

  try {
    const startedAt = run.startedAt ?? new Date();
    const runningWithSession = await db
      .update(heartbeatRuns)
      .set({
        startedAt,
        sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
        contextSnapshot: context,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (runningWithSession) run = runningWithSession;

    const runningAgent = await db
      .update(agents)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (runningAgent) {
      publishLiveEvent({
        companyId: runningAgent.companyId,
        type: "agent.status",
        payload: {
          agentId: runningAgent.id,
          status: runningAgent.status,
          outcome: "running",
        },
      });
    }

    const currentRun = run;
    await appendRunEvent(currentRun, seq++, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
    });

    handle = await runLogStore.begin({
      companyId: run.companyId,
      agentId: run.agentId,
      runId,
    });

    await db
      .update(heartbeatRuns)
      .set({
        logStore: handle.store,
        logRef: handle.logRef,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      const sanitizedChunk = redactCurrentUserText(chunk);
      if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
      if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
      const ts = new Date().toISOString();

      if (handle) {
        await runLogStore.append(handle, {
          stream,
          chunk: sanitizedChunk,
          ts,
        });
      }

      const payloadChunk =
        sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
          ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
          : sanitizedChunk;

      publishLiveEvent({
        companyId: run.companyId,
        type: "heartbeat.run.log",
        payload: {
          runId: run.id,
          agentId: run.agentId,
          ts,
          stream,
          chunk: payloadChunk,
          truncated: payloadChunk.length !== sanitizedChunk.length,
        },
      });
    };
    for (const warning of runtimeWorkspaceWarnings) {
      await onLog("stderr", `[paperclip] ${warning}\n`);
    }

    const adapterEnv = Object.fromEntries(
      Object.entries(parseObject(resolvedConfig.env)).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    const runtimeServices = await ensureRuntimeServicesForRun({
      db,
      runId: run.id,
      agent: {
        id: agent.id,
        name: agent.name,
        companyId: agent.companyId,
      },
      issue: issueRef,
      workspace: executionWorkspace as any,
      config: resolvedConfig,
      adapterEnv,
      onLog,
    });
    if (runtimeServices.length > 0) {
      context.paperclipRuntimeServices = runtimeServices;
      context.paperclipRuntimePrimaryUrl =
        runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    if (issueId && (asBoolean(executionWorkspace.created, false) || runtimeServices.some((service) => !service.reused))) {
      try {
        await issuesSvc.addComment(
          issueId,
          buildWorkspaceReadyComment({
            workspace: executionWorkspace as any,
            runtimeServices,
          }),
          { agentId: agent.id },
        );
      } catch (err) {
        await onLog(
          "stderr",
          `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
      if (meta.env && secretKeys.size > 0) {
        for (const key of secretKeys) {
          if (key in meta.env) meta.env[key] = "***REDACTED***";
        }
      }
      await appendRunEvent(currentRun, seq++, {
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: meta as unknown as Record<string, unknown>,
      });
    };

    const adapter = getServerAdapter(agent.adapterType);
    const authToken = adapter.supportsLocalAgentJwt
      ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
      : null;
    if (adapter.supportsLocalAgentJwt && !authToken) {
      logger.warn(
        {
          companyId: agent.companyId,
          agentId: agent.id,
          runId: run.id,
          adapterType: agent.adapterType,
        },
        "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
      );
    }
    const adapterResult = await adapter.execute({
      runId: run.id,
      agent,
      runtime: runtimeForAdapter,
      config: resolvedConfig,
      context,
      onLog,
      onMeta: onAdapterMeta,
      authToken: authToken ?? undefined,
    } as any);

    const adapterManagedRuntimeServices = adapterResult.runtimeServices
      ? await persistAdapterManagedRuntimeServices({
          db,
          adapterType: agent.adapterType,
          runId: run.id,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          issue: issueRef,
          workspace: executionWorkspace as any,
          reports: adapterResult.runtimeServices,
        })
      : [];
    if (adapterManagedRuntimeServices.length > 0) {
      const combinedRuntimeServices = [
        ...runtimeServices,
        ...adapterManagedRuntimeServices,
      ];
      context.paperclipRuntimeServices = combinedRuntimeServices;
      context.paperclipRuntimePrimaryUrl =
        combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      if (issueId) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace as any,
              runtimeServices: adapterManagedRuntimeServices,
            }),
            { agentId: agent.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }

    const nextSessionState = resolveNextSessionState({
      codec: sessionCodec,
      adapterResult,
      previousParams: previousSessionParams,
      previousDisplayId: runtimeForAdapter.sessionDisplayId,
      previousLegacySessionId: runtimeForAdapter.sessionId,
    });

    const outcome = adapterOutcome(await getRun(run.id), adapterResult);
    const status = statusForOutcome(outcome);
    const logSummary = handle ? await runLogStore.finalize(handle) : null;

    await setRunStatus(run.id, status, {
      finishedAt: new Date(),
      error:
        outcome === "succeeded"
          ? null
          : redactCurrentUserText(
              adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
            ),
      errorCode:
        outcome === "timed_out"
          ? "timeout"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "failed"
              ? (adapterResult.errorCode ?? "adapter_failed")
              : null,
      exitCode: adapterResult.exitCode,
      signal: adapterResult.signal,
      usageJson: usageJsonForResult(adapterResult),
      resultJson: adapterResult.resultJson ?? null,
      sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
      stdoutExcerpt,
      stderrExcerpt,
      logBytes: logSummary?.bytes,
      logSha256: logSummary?.sha256,
      logCompressed: logSummary?.compressed ?? false,
    });

    await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
      finishedAt: new Date(),
      error: adapterResult.errorMessage ?? null,
    });

    const finalizedRun = await getRun(run.id);
    if (finalizedRun) {
      await appendRunEvent(finalizedRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: outcome === "succeeded" ? "info" : "error",
        message: `run ${outcome}`,
        payload: {
          status,
          exitCode: adapterResult.exitCode,
        },
      });
      await releaseIssueExecutionAndPromote(finalizedRun);
    }

    if (finalizedRun) {
      await updateRuntimeState(agent, finalizedRun, adapterResult, {
        legacySessionId: nextSessionState.legacySessionId,
      });
      if (taskKey) {
        if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
          await clearTaskSessions(agent.companyId, agent.id, {
            taskKey,
            adapterType: agent.adapterType,
          });
        } else {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: nextSessionState.params,
            sessionDisplayId: nextSessionState.displayId,
            lastRunId: finalizedRun.id,
            lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
          });
        }
      }
    }
    await finalizeAgentStatus(agent.id, outcome);
  } catch (err) {
    const message = redactCurrentUserText(err instanceof Error ? err.message : "Unknown adapter failure");
    logger.error({ err, runId }, "heartbeat execution failed");

    let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
    if (handle) {
      try {
        logSummary = await runLogStore.finalize(handle);
      } catch (finalizeErr) {
        logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
      }
    }

    const failedRun = await setRunStatus(run.id, "failed", {
      error: message,
      errorCode: "adapter_failed",
      finishedAt: new Date(),
      stdoutExcerpt,
      stderrExcerpt,
      logBytes: logSummary?.bytes,
      logSha256: logSummary?.sha256,
      logCompressed: logSummary?.compressed ?? false,
    });
    await setWakeupStatus(run.wakeupRequestId, "failed", {
      finishedAt: new Date(),
      error: message,
    });

    if (failedRun) {
      await appendRunEvent(failedRun, seq++, {
        eventType: "error",
        stream: "system",
        level: "error",
        message,
      });
      await releaseIssueExecutionAndPromote(failedRun);

      await updateRuntimeState(agent, failedRun, {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: message,
      }, {
        legacySessionId: runtimeForAdapter.sessionId,
      });

      if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
        await upsertTaskSession({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson: previousSessionParams,
          sessionDisplayId: previousSessionDisplayId,
          lastRunId: failedRun.id,
          lastError: message,
        });
      }
    }

    await finalizeAgentStatus(agent.id, "failed");
  }
}
