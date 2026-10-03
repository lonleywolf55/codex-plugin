import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  patchJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  withStateLock,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_MODULE = fileURLToPath(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url));

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("concurrent upsertJob calls from separate processes never lose updates", async () => {
  const workspace = makeTempDir();
  const writers = 6;
  const perWriter = 7; // keep the total under the 50-job index cap so every write is observable

  const script = `
    import { upsertJob } from ${JSON.stringify(STATE_MODULE)};
    const [workspace, writer, count] = process.argv.slice(2);
    for (let index = 0; index < Number(count); index += 1) {
      upsertJob(workspace, { id: \`job-\${writer}-\${index}\`, status: "completed" });
    }
  `;
  const scriptPath = path.join(makeTempDir(), "writer.mjs");
  fs.writeFileSync(scriptPath, script, "utf8");

  await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath, workspace, String(writer), String(perWriter)], { stdio: "inherit" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${writer} exited ${code}`))));
      })
    )
  );

  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.equal(state.jobs.length, writers * perWriter);
  assert.equal(fs.existsSync(path.join(resolveStateDir(workspace), "state.lock")), false);
});

test("withStateLock is re-entrant and reclaims stale locks", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const stale = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lockDir, stale, stale);

  const started = Date.now();
  const value = withStateLock(workspace, () => withStateLock(workspace, () => "nested"));
  assert.equal(value, "nested");
  assert.ok(Date.now() - started < 4000, "a stale lock must be reclaimed quickly");
  assert.equal(fs.existsSync(lockDir), false);
});

test("patchJobFile merges into the stored job and supports conditional patches", () => {
  const workspace = makeTempDir();
  assert.equal(patchJobFile(workspace, "missing", { pid: 1 }), null);

  writeJobFile(workspace, "job-1", { id: "job-1", status: "running", pid: null });
  const merged = patchJobFile(workspace, "job-1", { heartbeatAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(merged.status, "running");
  assert.equal(merged.heartbeatAt, "2026-01-01T00:00:00.000Z");

  const conditional = patchJobFile(workspace, "job-1", (existing) => (existing.pid == null ? { pid: 4242 } : {}));
  assert.equal(conditional.pid, 4242);
  const unchanged = patchJobFile(workspace, "job-1", (existing) => (existing.pid == null ? { pid: 1 } : {}));
  assert.equal(unchanged.pid, 4242);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, "job-1"), "utf8")).pid, 4242);
});
