import test from "node:test";
import assert from "node:assert/strict";

import { snapshotProcessTree, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree falls back to the process when no Unix group exists", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "darwin",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) throw Object.assign(new Error("missing group"), { code: "ESRCH" });
    }
  });
  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("process snapshots include detached descendants and stop children before parents", () => {
  const snapshot = snapshotProcessTree(10, {
    platform: "darwin",
    runCommandImpl() {
      return {
        status: 0,
        stdout: "10 1 original root\n20 10 original child\n30 20 original grandchild\n40 1 unrelated\n"
      };
    }
  });
  assert.deepEqual(
    snapshot.map((entry) => entry.pid),
    [30, 20, 10]
  );
});
test("process snapshot cleanup skips reused process identities", () => {
  const calls = [];
  terminateProcessTree(10, {
    platform: "darwin",
    snapshot: [
      { pid: 20, identity: "original child" },
      { pid: 10, identity: "original root" }
    ],
    runCommandImpl(command, args) {
      return { status: 0, stdout: args[1] === "20" ? "new child" : "original root" };
    },
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    }
  });
  assert.deepEqual(calls, [[-10, "SIGTERM"]]);
});
