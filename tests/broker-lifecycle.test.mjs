import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const script = path.resolve("plugins/codex/scripts/app-server-broker.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.ok(predicate(), "condition did not become true before timeout");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function startBroker(t, idleMs = 250, stubborn = false, detached = false, earlyExit = false, reparent = false) {
  const root = makeTempDir("cxc-idle-test-");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  const childPids = path.join(root, "children.json");
  const interruptState = path.join(root, "interrupt-state");
  writeExecutable(
    path.join(bin, "codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const {spawn} = require("node:child_process");
const descendantSource = ${JSON.stringify(reparent ? `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([Number(process.argv[2]),process.pid,child.pid]));setTimeout(()=>process.exit(0),500);` : stubborn ? 'process.on("SIGTERM",()=>{});setInterval(() => {}, 1000)' : "setInterval(() => {}, 1000)")};
const descendant = spawn(process.execPath, ["-e", descendantSource, ${JSON.stringify(childPids)},String(process.pid)], {stdio:"ignore",detached:${JSON.stringify(detached)}});
fs.writeFileSync(${JSON.stringify(childPids)}, JSON.stringify([process.pid, descendant.pid]));
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m=JSON.parse(line);
  if (m.id === undefined) return;
  if(m.method === "turn/interrupt") {
    fs.writeFileSync(${JSON.stringify(interruptState)},"pending");
    process.stdout.write(JSON.stringify({method:"turn/completed",params:{threadId:"long",turn:{id:"turn"}}})+"\\n");
    setTimeout(()=>{
      fs.writeFileSync(${JSON.stringify(interruptState)},"completed");
      process.stdout.write(JSON.stringify({id:m.id,result:{}})+"\\n");
    },1800);
    return;
  }
  if(m.method === "slow/request") {
    setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:{}})+"\\n"),700);
    return;
  }
  process.stdout.write(JSON.stringify({id:m.id,result:{}})+"\\n");
  if(m.method==="initialize" && ${JSON.stringify(earlyExit)}) setTimeout(()=>process.exit(0),100);
  if(m.method==="turn/start") {
    process.stdout.write(JSON.stringify({method:"turn/started",params:{threadId:"long",turn:{id:"turn"}}})+"\\n");
    setTimeout(()=>process.stdout.write(JSON.stringify({method:"turn/completed",params:{threadId:"long",turn:{id:"turn"}}})+"\\n"),700);
  }
});
`
  );
  const endpoint = path.join(root, "broker.sock");
  const pidFile = path.join(root, "broker.pid");
  const stateFile = resolveStateFile(workspace);
  const broker = spawn(
    process.execPath,
    [script, "serve", "--endpoint", `unix:${endpoint}`, "--cwd", workspace, "--pid-file", pidFile],
    {
      cwd: workspace,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: String(idleMs)
      }
    }
  );
  let stderr = "";
  broker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(broker, "exit");
  t.after(async () => {
    if (broker.exitCode === null && broker.signalCode === null) terminateProcessTree(broker.pid);
    if (fs.existsSync(childPids))
      for (const pid of JSON.parse(fs.readFileSync(childPids))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    await Promise.race([exited, delay(500)]);
    fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(endpoint));
  if (reparent) await waitFor(() => JSON.parse(fs.readFileSync(childPids)).length === 3);
  const pids = JSON.parse(fs.readFileSync(childPids));
  const brokerStateFile = path.join(path.dirname(stateFile), "broker.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(brokerStateFile, JSON.stringify({ pid: broker.pid, endpoint: `unix:${endpoint}` }));
  function jobs(status) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ jobs: [{ id: "job", status }] }));
  }
  async function connect() {
    const socket = net.createConnection(endpoint);
    await once(socket, "connect");
    t.after(() => socket.destroy());
    return socket;
  }
  async function stopped() {
    await waitFor(() => broker.exitCode !== null || broker.signalCode !== null);
    assert.equal(stderr, "");
    await waitFor(() => pids.every((pid) => !alive(pid)));
    assert.equal(fs.existsSync(endpoint), false);
    assert.equal(fs.existsSync(pidFile), false);
    if (fs.existsSync(brokerStateFile)) {
      assert.notEqual(JSON.parse(fs.readFileSync(brokerStateFile)).pid, broker.pid);
    }
  }
  return {
    broker,
    workspace,
    endpoint,
    pidFile,
    pids,
    stateFile,
    brokerStateFile,
    interruptState,
    jobs,
    connect,
    stopped
  };
}

test(
  "idle broker without a first client exits and cleans its app-server and descendants",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t);
    await b.stopped();
  }
);
test(
  "broker survives connected clients then cleans up after disconnect and removed workspace",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t);
    const client = await b.connect();
    await delay(600);
    assert.ok(alive(b.broker.pid));
    fs.renameSync(b.workspace, `${b.workspace}-trash`);
    client.destroy();
    await b.stopped();
  }
);
for (const status of ["queued", "running"]) {
  test(
    `idle broker protects ${status} jobs then exits after completion`,
    { skip: process.platform === "win32" },
    async (t) => {
      const b = await startBroker(t);
      b.jobs(status);
      await delay(600);
      assert.ok(alive(b.broker.pid));
      b.jobs("completed");
      await b.stopped();
    }
  );
}
test("broker protects a turn after its client disconnects", { skip: process.platform === "win32" }, async (t) => {
  const b = await startBroker(t);
  const client = await b.connect();
  client.write(
    JSON.stringify({
      id: 2,
      method: "turn/start",
      params: { threadId: "long" }
    }) + "\n"
  );
  await once(client, "data");
  await delay(30);
  client.destroy();
  await delay(450);
  assert.ok(alive(b.broker.pid));
  await b.stopped();
});
test(
  "explicit broker shutdown also stops app-server descendants",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t, 5000);
    const client = await b.connect();
    client.write(JSON.stringify({ id: 1, method: "broker/shutdown" }) + "\n");
    client.resume();
    await b.stopped();
  }
);

test("broker protects an in-flight request after disconnect", { skip: process.platform === "win32" }, async (t) => {
  const b = await startBroker(t);
  const client = await b.connect();
  client.write(JSON.stringify({ id: 2, method: "slow/request" }) + "\n");
  await delay(30);
  client.destroy();
  await delay(450);
  assert.ok(alive(b.broker.pid));
  await b.stopped();
});
test("broker fails closed on unreadable job state", { skip: process.platform === "win32" }, async (t) => {
  const b = await startBroker(t);
  fs.mkdirSync(path.dirname(b.stateFile), { recursive: true });
  fs.writeFileSync(b.stateFile, "{invalid");
  await delay(600);
  assert.ok(alive(b.broker.pid));
  b.jobs("completed");
  await b.stopped();
});
test(
  "broker forcibly cleans descendants that ignore graceful termination",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t, 250, true);
    await b.stopped();
  }
);
test(
  "invalid idle timeout retains the conservative startup grace",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t, "invalid");
    await delay(600);
    assert.ok(alive(b.broker.pid));
    const client = await b.connect();
    client.write(JSON.stringify({ id: 1, method: "broker/shutdown" }) + "\n");
    client.resume();
    await b.stopped();
  }
);

test(
  "broker cleans a descendant that detached into a separate process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t, 250, false, true);
    await b.stopped();
  }
);

test(
  "old broker shutdown preserves a replacement broker's ownership record",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t);
    fs.writeFileSync(b.brokerStateFile, JSON.stringify({ pid: 999999, endpoint: "unix:/replacement.sock" }));
    await b.stopped();
    assert.equal(JSON.parse(fs.readFileSync(b.brokerStateFile)).pid, 999999);
  }
);

for (const job of [
  {},
  { id: "job", status: "unknown" },
  { id: "job", status: null },
  { status: "completed" },
  null,
  [],
  "completed"
]) {
  test(`broker protects malformed job ${JSON.stringify(job)}`, { skip: process.platform === "win32" }, async (t) => {
    const b = await startBroker(t);
    fs.mkdirSync(path.dirname(b.stateFile), { recursive: true });
    fs.writeFileSync(b.stateFile, JSON.stringify({ jobs: [job] }));
    await delay(600);
    assert.ok(alive(b.broker.pid));
    b.jobs("completed");
    await b.stopped();
  });
}
test(
  "idle shutdown cleans known children after the original app-server exited",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t, 400, false, true, true);
    await b.stopped();
  }
);

test(
  "idle shutdown retains an observed detached grandchild after its intermediate parent exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t, 1200, false, false, false, true);
    await waitFor(() => !alive(b.pids[1]));
    assert.ok(alive(b.pids[2]));
    await b.stopped();
  }
);
test(
  "broker protects an interrupt request after its stream completes and clients disconnect",
  { skip: process.platform === "win32" },
  async (t) => {
    const b = await startBroker(t);
    const primary = await b.connect();
    primary.write(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "long" } }) + "\n");
    await once(primary, "data");
    await delay(30);
    const interrupt = await b.connect();
    interrupt.write(
      JSON.stringify({ id: 2, method: "turn/interrupt", params: { threadId: "long", turnId: "turn" } }) + "\n"
    );
    await delay(30);
    primary.destroy();
    interrupt.destroy();
    await delay(1000);
    assert.equal(fs.readFileSync(b.interruptState, "utf8"), "pending");
    assert.ok(alive(b.broker.pid));
    assert.ok(alive(b.pids[0]));
    await b.stopped();
    assert.equal(fs.readFileSync(b.interruptState, "utf8"), "completed");
  }
);
