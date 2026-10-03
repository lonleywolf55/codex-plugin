import fs from "node:fs";
import process from "node:process";

import { listJobs, readJobFile, resolveJobFile, upsertJob, withStateLock, writeJobFile } from "./state.mjs";

/**
 * Job liveness tracking.
 *
 * Job state lives in two places: the per-workspace `state.json` index and a
 * per-job `<id>.json` file. Both are written by the process that runs the job.
 * If that process dies (Claude Code killed a timed-out Bash call, the session
 * ended, the machine rebooted, Node crashed) nothing would ever move the job
 * out of `queued`/`running`, and `/codex:status` would report a job as active
 * forever. This module reconciles stored state with what is actually alive on
 * the machine before any command reads it.
 */

export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const STALL_AFTER_ENV = "CODEX_COMPANION_STALL_AFTER_MS";
export const DEFAULT_STALL_AFTER_MS = 10 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 15 * 1000;
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const QUEUED_WITHOUT_PID_GRACE_MS = 60 * 1000;
export const QUEUED_START_GRACE_MS = 2 * 60 * 1000;

export function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * @returns {boolean | null} true when alive, false when definitely gone, null when unknown.
 */
export function isProcessAlive(pid, options = {}) {
  const normalized = normalizePid(pid);
  if (normalized === null) {
    return null;
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(normalized, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    return null;
  }
}

export function resolveStallThresholdMs(env = process.env) {
  const raw = env?.[STALL_AFTER_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_STALL_AFTER_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STALL_AFTER_MS;
  }
  return parsed;
}

function appendLog(logFile, message) {
  if (!logFile || !message) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${message}\n`, "utf8");
  } catch {
    // The log is advisory; never fail reconciliation because of it.
  }
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return readJobFile(jobFile);
  } catch {
    return null;
  }
}

/**
 * Decides whether the process that owns an active job is gone.
 */
export function assessWorker(job, storedJob, options = {}) {
  const now = options.now ?? Date.now();
  const pid = normalizePid(job.pid ?? storedJob?.pid);
  const heartbeatAt = parseTime(storedJob?.heartbeatAt);

  if (pid !== null) {
    const alive = isProcessAlive(pid, options);
    if (alive === false) {
      return { dead: true, pid, alive, reason: `its worker process (pid ${pid}) is no longer running` };
    }
    if (alive === true && heartbeatAt !== null && now - heartbeatAt > HEARTBEAT_STALE_MS) {
      return {
        dead: true,
        pid,
        alive,
        reason: `its worker process (pid ${pid}) stopped sending heartbeats ${formatDuration(now - heartbeatAt)} ago`
      };
    }
    if (alive === true && job.status === "queued" && heartbeatAt === null) {
      // A worker that never got as far as its first heartbeat crashed while
      // booting; the pid may since have been reused by an unrelated process.
      const createdAt = parseTime(job.createdAt);
      if (createdAt !== null && now - createdAt > QUEUED_START_GRACE_MS) {
        return {
          dead: true,
          pid,
          alive,
          reason: `its worker process (pid ${pid}) never started running the job`
        };
      }
    }
    return { dead: false, pid, alive };
  }

  if (job.status === "queued") {
    const createdAt = parseTime(job.createdAt);
    if (createdAt !== null && now - createdAt > QUEUED_WITHOUT_PID_GRACE_MS) {
      return { dead: true, pid: null, alive: null, reason: "its background worker never started" };
    }
  }

  return { dead: false, pid: null, alive: null };
}

export function buildWorkerLossMessage(job, reason) {
  const parts = [`Codex job ${job.id} stopped without recording a result: ${reason}.`];
  if (job.threadId) {
    parts.push(
      `The Codex thread ${job.threadId} may still be running or may have finished inside the Codex runtime; inspect it with \`codex resume ${job.threadId}\`.`
    );
  }
  parts.push(
    "Common causes: the worker was killed (for example by the Claude session ending or a forced process-tree kill), it crashed, or the machine restarted."
  );
  return parts.join(" ");
}

/**
 * Applies a terminal transition to a job unless it already reached a terminal
 * state. Both the job file and the index are updated under the workspace
 * lock, so this is safe from signal handlers and from other processes.
 *
 * @returns {boolean} true when the job was transitioned.
 */
export function transitionJobIfActive(workspaceRoot, jobId, patch, options = {}) {
  return withStateLock(workspaceRoot, () => {
    const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
    const indexedJob = listJobs(workspaceRoot).find((job) => job.id === jobId) ?? null;
    const currentStatus = storedJob?.status ?? indexedJob?.status ?? null;
    if (currentStatus !== null && !isActiveJobStatus(currentStatus)) {
      return false;
    }
    if (storedJob === null && indexedJob === null) {
      return false;
    }

    const completedAt = nowIso();
    const resolvedPatch = {
      pid: null,
      completedAt,
      ...patch
    };

    if (storedJob) {
      writeJobFile(workspaceRoot, jobId, { ...storedJob, ...resolvedPatch, ...(options.storedExtra ?? {}) });
    }
    if (indexedJob) {
      upsertJob(workspaceRoot, { id: jobId, ...resolvedPatch });
    }
    appendLog(storedJob?.logFile ?? indexedJob?.logFile ?? null, options.logMessage ?? resolvedPatch.errorMessage ?? null);
    return true;
  });
}

/**
 * Moves an active job to `failed` unless it already reached a terminal state.
 *
 * @returns {boolean} true when the job was transitioned.
 */
export function markJobFailedIfActive(workspaceRoot, jobId, errorMessage, options = {}) {
  return transitionJobIfActive(
    workspaceRoot,
    jobId,
    {
      status: "failed",
      phase: "failed",
      errorMessage,
      ...(options.extra ?? {})
    },
    { logMessage: errorMessage }
  );
}

/**
 * Moves an active job to `cancelled` unless it already reached a terminal state.
 *
 * @returns {boolean} true when the job was transitioned.
 */
export function markJobCancelledIfActive(workspaceRoot, jobId, options = {}) {
  const errorMessage = options.errorMessage ?? "Cancelled by user.";
  const completedAt = nowIso();
  return transitionJobIfActive(
    workspaceRoot,
    jobId,
    {
      status: "cancelled",
      phase: "cancelled",
      errorMessage,
      completedAt
    },
    { storedExtra: { cancelledAt: completedAt }, logMessage: errorMessage }
  );
}

/**
 * Brings `state.json` in line with the per-job files and with process liveness.
 *
 * - A job whose own file already reached a terminal state (but whose index entry
 *   was lost to a concurrent write) adopts that terminal state.
 * - A job whose worker process is gone is marked failed with an explanation.
 *
 * @returns {Array<{ id: string, from: string, to: string, reason: string }>}
 */
export function reconcileJobs(workspaceRoot, options = {}) {
  const changes = [];
  const jobs = listJobs(workspaceRoot);
  const activeJobs = jobs.filter((job) => isActiveJobStatus(job.status));
  if (activeJobs.length === 0) {
    return changes;
  }

  withStateLock(workspaceRoot, () => {
    for (const job of listJobs(workspaceRoot)) {
      if (!isActiveJobStatus(job.status)) {
        continue;
      }

      const storedJob = readStoredJobOrNull(workspaceRoot, job.id);
      if (storedJob && isTerminalJobStatus(storedJob.status)) {
        upsertJob(workspaceRoot, {
          id: job.id,
          status: storedJob.status,
          phase: storedJob.phase ?? (storedJob.status === "completed" ? "done" : storedJob.status),
          pid: null,
          completedAt: storedJob.completedAt ?? storedJob.cancelledAt ?? nowIso(),
          ...(storedJob.threadId ? { threadId: storedJob.threadId } : {}),
          ...(storedJob.turnId ? { turnId: storedJob.turnId } : {}),
          ...(storedJob.summary ? { summary: storedJob.summary } : {}),
          ...(storedJob.errorMessage ? { errorMessage: storedJob.errorMessage } : {})
        });
        changes.push({ id: job.id, from: job.status, to: storedJob.status, reason: "adopted terminal state from job file" });
        continue;
      }

      const assessment = assessWorker(job, storedJob, options);
      if (!assessment.dead) {
        continue;
      }

      const message = buildWorkerLossMessage(job, assessment.reason);
      if (markJobFailedIfActive(workspaceRoot, job.id, message)) {
        changes.push({ id: job.id, from: job.status, to: "failed", reason: assessment.reason });
      }
    }
  });

  return changes;
}

/**
 * Lists jobs after reconciling stale entries.
 */
export function listReconciledJobs(workspaceRoot, options = {}) {
  reconcileJobs(workspaceRoot, options);
  return listJobs(workspaceRoot);
}

/**
 * Computes activity/idle information for an active job.
 */
export function describeActivity(job, storedJob, options = {}) {
  const now = options.now ?? Date.now();
  const stallAfterMs = options.stallAfterMs ?? resolveStallThresholdMs(options.env);
  const lastActivityAt =
    storedJob?.lastActivityAt ?? job.lastActivityAt ?? storedJob?.startedAt ?? job.startedAt ?? job.updatedAt ?? job.createdAt ?? null;
  const lastActivityTime = parseTime(lastActivityAt);
  const idleMs = lastActivityTime === null ? null : Math.max(0, now - lastActivityTime);
  const heartbeatAt = storedJob?.heartbeatAt ?? null;
  const assessment = isActiveJobStatus(job.status) ? assessWorker(job, storedJob, options) : null;

  return {
    lastActivityAt,
    idleMs,
    idle: idleMs === null ? null : formatDuration(idleMs),
    heartbeatAt,
    workerPid: assessment?.pid ?? null,
    workerAlive: assessment?.alive ?? null,
    possiblyStalled: isActiveJobStatus(job.status) && idleMs !== null && stallAfterMs > 0 && idleMs > stallAfterMs
  };
}
