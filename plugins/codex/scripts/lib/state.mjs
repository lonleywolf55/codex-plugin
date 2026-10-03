import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const LOCK_DIR_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

// Re-entrancy tracking for the per-workspace lock (keyed by lock directory).
const heldLocks = new Map();
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(ms) {
  try {
    Atomics.wait(sleepBuffer, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy wait fallback
    }
  }
}

function resolveLockDir(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
}

/**
 * Removes a lock left behind by a process that died while holding it.
 * The directory is renamed first so that only one contender can reclaim it;
 * everyone else keeps waiting for the fresh lock the winner creates.
 *
 * @returns {boolean} true when the caller should retry acquiring immediately.
 */
function reclaimStaleLock(lockDir) {
  let stats;
  try {
    stats = fs.statSync(lockDir);
  } catch (error) {
    // The lock vanished between mkdir and stat; retry right away.
    return error?.code === "ENOENT";
  }
  if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) {
    return false;
  }

  const stalePath = `${lockDir}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(lockDir, stalePath);
  } catch (error) {
    // Someone else reclaimed it first (ENOENT) or the directory is pinned
    // (EBUSY/EPERM on Windows); either way, wait and look again.
    return error?.code === "ENOENT";
  }
  try {
    fs.rmSync(stalePath, { recursive: true, force: true });
  } catch {
    // Leftover junk never blocks the lock again because it was renamed away.
  }
  return true;
}

/**
 * Runs `fn` while holding a cross-process lock for the workspace state.
 *
 * Multiple companion processes (the Claude-side command, detached workers,
 * the stop hook, and `/codex:cancel`) all read-modify-write `state.json`.
 * Without a lock, concurrent updates silently drop each other's writes, which
 * is one way a finished job could stay "running" forever.
 *
 * The lock is a directory created with `mkdir` (atomic on every platform).
 * It is re-entrant within one process and stale locks are reclaimed.
 */
export function withStateLock(cwd, fn) {
  const lockDir = resolveLockDir(cwd);
  const depth = heldLocks.get(lockDir) ?? 0;
  if (depth > 0) {
    heldLocks.set(lockDir, depth + 1);
    try {
      return fn();
    } finally {
      const current = heldLocks.get(lockDir) ?? 1;
      if (current <= 1) {
        heldLocks.delete(lockDir);
      } else {
        heldLocks.set(lockDir, current - 1);
      }
    }
  }

  ensureStateDir(cwd);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    if (reclaimStaleLock(lockDir)) {
      continue;
    }
    if (Date.now() > deadline) {
      // Never deadlock a command on a wedged lock; proceed best-effort.
      break;
    }
    sleepSync(5 + Math.floor(Math.random() * 20));
  }

  heldLocks.set(lockDir, 1);
  try {
    return fn();
  } finally {
    heldLocks.delete(lockDir);
    if (acquired) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // Ignore a lock that was reclaimed by another process.
      }
    }
  }
}

function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  // On Windows a rename over a file that an indexer or scanner has open can
  // fail transiently; retry briefly before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      const transient = error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
      if (!transient || attempt >= 5) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Ignore cleanup failures.
        }
        throw error;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

function readJsonFileRetrying(filePath, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      if (error?.code === "ENOENT") {
        throw error;
      }
      sleepSync(10);
    }
  }
  throw lastError;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = readJsonFileRetrying(stateFile);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => {
    const previousJobs = loadState(cwd).jobs;
    ensureStateDir(cwd);
    const nextJobs = pruneJobs(state.jobs ?? []);
    const nextState = {
      version: STATE_VERSION,
      config: {
        ...defaultState().config,
        ...(state.config ?? {})
      },
      jobs: nextJobs
    };

    const retainedIds = new Set(nextJobs.map((job) => job.id));
    for (const job of previousJobs) {
      if (retainedIds.has(job.id)) {
        continue;
      }
      removeJobFile(resolveJobFile(cwd, job.id));
      removeFileIfExists(job.logFile);
    }

    writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
    return nextState;
  });
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  return withStateLock(cwd, () => {
    ensureStateDir(cwd);
    const jobFile = resolveJobFile(cwd, jobId);
    writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
    return jobFile;
  });
}

/**
 * Merges `patch` into the stored job file under the workspace lock.
 * Returns the merged record, or null when no job file exists yet.
 */
export function patchJobFile(cwd, jobId, patch) {
  return withStateLock(cwd, () => {
    const jobFile = resolveJobFile(cwd, jobId);
    if (!fs.existsSync(jobFile)) {
      return null;
    }
    const existing = readJobFile(jobFile);
    const merged = {
      ...existing,
      ...(typeof patch === "function" ? patch(existing) : patch)
    };
    writeFileAtomic(jobFile, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
}

export function readJobFile(jobFile) {
  return readJsonFileRetrying(jobFile);
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
