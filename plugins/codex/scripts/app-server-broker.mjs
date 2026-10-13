#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { snapshotProcessTree, terminateProcessTree } from "./lib/process.mjs";
import { resolveStateFile } from "./lib/state.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const stateFile = resolveStateFile(cwd);
  const brokerStateFile = path.join(path.dirname(stateFile), "broker.json");
  const configuredIdleMs = Number(process.env.CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS);
  const idleTimeoutMs = Number.isFinite(configuredIdleMs) && configuredIdleMs > 0 ? configuredIdleMs : 30 * 60 * 1000;
  const appClient = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    detached: true
  });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  const runningTurns = new Set();
  let pendingRequests = 0;
  let idleSince = Date.now();
  let shutdownPromise = null;

  function hasActiveJobs() {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (!Array.isArray(state.jobs)) return true;
      return state.jobs.some((job) => job.status === "queued" || job.status === "running");
    } catch (error) {
      return error.code !== "ENOENT";
    }
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const turnId = message.params?.turn?.id;
    if (message.method === "turn/started" && turnId) runningTurns.add(turnId);
    if (message.method === "turn/completed" && turnId) runningTurns.delete(turnId);
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  function shutdown(server) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      clearInterval(idleTimer);
      const serverClosed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      const appServerPid = appClient.proc.pid;
      const snapshot = snapshotProcessTree(appServerPid);
      terminateProcessTree(appServerPid, { snapshot });
      const forceTimer = setTimeout(() => terminateProcessTree(appServerPid, { signal: "SIGKILL", snapshot }), 1000);
      // Preserve child identities across reparenting when the app-server exits first.
      await Promise.race([appClient.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1100))]);
      terminateProcessTree(appServerPid, { signal: "SIGKILL", snapshot });
      clearTimeout(forceTimer);
      await serverClosed;
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) fs.unlinkSync(listenTarget.path);
      if (pidFile && fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      try {
        const session = JSON.parse(fs.readFileSync(brokerStateFile, "utf8"));
        if (session.pid === process.pid && session.endpoint === endpoint) fs.unlinkSync(brokerStateFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    })();
    return shutdownPromise;
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    idleSince = Date.now();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) ||
            (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        pendingRequests++;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        } finally {
          pendingRequests--;
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      idleSince = Date.now();
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      idleSince = Date.now();
      clearSocketOwnership(socket);
    });
  });

  const idleTimer = setInterval(
    () => {
      if (sockets.size || pendingRequests || runningTurns.size || hasActiveJobs()) {
        idleSince = Date.now();
        return;
      }
      if (Date.now() - idleSince >= idleTimeoutMs) {
        shutdown(server)
          .then(() => process.exit(0))
          .catch((error) => {
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
          });
      }
    },
    Math.min(10_000, Math.max(25, idleTimeoutMs / 4))
  );

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
