import fs from "node:fs";
import process from "node:process";

import { HEARTBEAT_INTERVAL_MS, markJobFailedIfActive } from "./liveness.mjs";
import { patchJobFile, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const ACTIVITY_WRITE_THROTTLE_MS = 1000;

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastActivityWriteAt = 0;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    // Every progress event proves the Codex run is still producing output, so
    // record it on the job file (throttled) even when nothing else changed.
    // `/codex:status` uses this to flag runs that have gone quiet.
    const now = Date.now();
    const activityDue = now - lastActivityWriteAt >= ACTIVITY_WRITE_THROTTLE_MS;
    if (!changed && !activityDue) {
      return;
    }

    // Progress bookkeeping must never take the job down: a transient file
    // error here (for example a share violation on Windows) is not a Codex
    // failure, and an exception from a notification handler would be fatal.
    try {
      if (changed) {
        upsertJob(workspaceRoot, patch);
      }

      lastActivityWriteAt = now;
      const { id: _ignored, ...filePatch } = patch;
      patchJobFile(workspaceRoot, jobId, {
        ...filePatch,
        lastActivityAt: new Date(now).toISOString()
      });
    } catch {
      // Retried implicitly by the next event or heartbeat.
    }
  };
}

function registerWorkerGuards(job, options = {}) {
  const workspaceRoot = job.workspaceRoot;
  const jobId = job.id;
  let active = true;

  const failIfActive = (message) => {
    if (!active) {
      return false;
    }
    try {
      return markJobFailedIfActive(workspaceRoot, jobId, message);
    } catch {
      return false;
    }
  };

  const signalNames = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGTERM", "SIGINT", "SIGHUP"];
  const signalHandlers = new Map();
  for (const signalName of signalNames) {
    const handler = () => {
      failIfActive(
        `Codex job ${jobId} was interrupted by ${signalName} before Codex finished. The process running it was stopped (for example by a Claude Code Bash timeout, /codex:cancel, or the session ending).`
      );
      options.onSignal?.(signalName);
      process.exit(128 + (signalName === "SIGINT" ? 2 : signalName === "SIGHUP" ? 1 : 15));
    };
    signalHandlers.set(signalName, handler);
    try {
      process.on(signalName, handler);
    } catch {
      // Some platforms reject some signals; ignore.
    }
  }

  const onBeforeExit = () => {
    // The event loop drained while the job was still active: the connection to
    // Codex went away without anyone rejecting the pending turn. Never let the
    // process exit 0 while the job record still says "running".
    if (
      failIfActive(
        `Codex job ${jobId} lost its connection to the Codex app-server before the turn completed, so no result was recorded.`
      )
    ) {
      process.exitCode = 1;
    }
  };
  const onUncaught = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    failIfActive(`Codex job ${jobId} crashed before Codex finished: ${message}`);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };

  process.on("beforeExit", onBeforeExit);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  let heartbeatTimer = null;
  const writeHeartbeat = () => {
    try {
      patchJobFile(workspaceRoot, jobId, { heartbeatAt: nowIso() });
    } catch {
      // Heartbeats are advisory.
    }
  };
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  return () => {
    active = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const [signalName, handler] of signalHandlers) {
      process.off(signalName, handler);
    }
    process.off("beforeExit", onBeforeExit);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const startedAt = nowIso();
  const runningRecord = {
    ...job,
    status: "running",
    startedAt,
    phase: "starting",
    pid: process.pid,
    lastActivityAt: startedAt,
    heartbeatAt: startedAt,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  // Keep request payloads and captured results out of the index.
  const { request: _request, result: _result, rendered: _rendered, ...indexRecord } = runningRecord;
  upsertJob(job.workspaceRoot, indexRecord);

  const releaseGuards = registerWorkerGuards(runningRecord, options);

  try {
    const execution = await runner();
    const completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    // A user cancellation that raced with the final turn keeps its "cancelled"
    // outcome; the captured output is still stored for `/codex:result`.
    const wasCancelled = existing.status === "cancelled";
    const completionStatus = wasCancelled ? "cancelled" : execution.exitStatus === 0 ? "completed" : "failed";
    const completionPhase = wasCancelled ? "cancelled" : completionStatus === "completed" ? "done" : "failed";
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      ...(wasCancelled ? existing : {}),
      ...(existing.lastActivityAt ? { lastActivityAt: existing.lastActivityAt } : {}),
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionPhase,
      completedAt: wasCancelled ? existing.completedAt ?? completedAt : completedAt,
      // Clear any failure recorded by an earlier false alarm (for example a
      // stale heartbeat after the machine slept) now that the run finished.
      errorMessage: wasCancelled ? existing.errorMessage ?? null : null,
      summary: execution.summary ?? runningRecord.summary ?? null,
      codexStatus: execution.exitStatus ?? null,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionPhase,
      pid: null,
      errorMessage: wasCancelled ? existing.errorMessage ?? null : null,
      completedAt: wasCancelled ? existing.completedAt ?? completedAt : completedAt
    });
    releaseGuards();
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    releaseGuards();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    if (existing.status === "cancelled") {
      // `/codex:cancel` already recorded the outcome; keep it.
      appendLogLine(options.logFile ?? job.logFile ?? existing.logFile ?? null, errorMessage);
      throw error;
    }
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    appendLogLine(options.logFile ?? job.logFile ?? existing.logFile ?? null, `Failed: ${errorMessage}`);
    throw error;
  }
}
