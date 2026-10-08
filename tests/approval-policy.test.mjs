import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function repoWithUncommittedChange() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  return repo;
}

function approvalPolicySentBy(args) {
  const repo = repoWithUncommittedChange();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const result = run("node", [SCRIPT, ...args], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return state.lastThreadStartApprovalPolicy;
}

// A null approval policy lets the app-server apply approval_policy and approvals_reviewer from config.toml.
for (const args of [["task", "inspect the change"], ["task", "--write", "apply the fix"], ["review"], ["adversarial-review"]]) {
  test(`${args.join(" ")} defers the approval policy to the user's Codex config`, () => {
    assert.equal(approvalPolicySentBy(args), null);
  });
}
