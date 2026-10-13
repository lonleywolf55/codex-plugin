import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? process.env.SHELL || true : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function normalizeProcessStartTime(value) {
  return value.trim().split(/\s+/).slice(0, 5).join(" ");
}

export function readProcessStartTime(pid, options = {}) {
  if ((options.platform ?? process.platform) === "win32") return null;
  const result = (options.runCommandImpl ?? runCommand)("ps", ["-p", String(pid), "-o", "lstart="], { shell: false });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return normalizeProcessStartTime(result.stdout);
}

export function snapshotProcessTree(pid, options = {}) {
  if ((options.platform ?? process.platform) === "win32") return null;
  const run = options.runCommandImpl ?? runCommand;
  const result = run("ps", ["-axo", "pid=,ppid=,lstart=,comm="], { shell: false });
  if (result.error || result.status !== 0) throw new Error("Cannot inspect app-server descendants for cleanup.");
  const rows = result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), identity: match[3].trim() }] : [];
  });
  const descendants = rows.filter((entry) => entry.pid === pid);
  if (
    "expectedRootStartedAt" in options &&
    (!options.expectedRootStartedAt ||
      normalizeProcessStartTime(descendants[0]?.identity ?? "") !== options.expectedRootStartedAt)
  ) {
    return [];
  }
  for (let index = 0; index < descendants.length; index++) {
    descendants.push(...rows.filter((entry) => entry.parentPid === descendants[index].pid));
  }
  return descendants.reverse();
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  if (options.snapshot) {
    const results = options.snapshot.map((entry) => {
      const current = runCommandImpl("ps", ["-p", String(entry.pid), "-o", "lstart=,comm="], { shell: false });
      if (current.error || current.status !== 0 || current.stdout.trim() !== entry.identity) {
        return { attempted: false, delivered: false, method: "identity-check" };
      }
      return terminateProcessTree(entry.pid, { ...options, snapshot: null });
    });
    return {
      attempted: results.some((result) => result.attempted),
      delivered: results.some((result) => result.delivered),
      method: "descendant-snapshot"
    };
  }

  const signal = options.signal ?? "SIGTERM";
  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    try {
      killImpl(pid, signal);
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
