# Changelog

## 1.0.7

- Fix background and foreground Codex jobs getting stuck in `running`/`queued` forever when the process running them died (Claude Code Bash timeout, session end, crash, reboot). `/codex:status`, `/codex:result`, `/codex:cancel`, and the stop hook now reconcile every active job against process liveness and the per-job file before reporting it.
- Run every review and task in a detached worker; the Claude-side command only attaches to it. A killed or timed-out `Bash` call no longer loses the Codex result.
- Foreground commands accept `--wait-timeout-ms` (default 9.5 minutes, env `CODEX_COMPANION_WAIT_TIMEOUT_MS`) and print a "still running" notice with the job id instead of being killed by Claude Code's Bash timeout.
- Fail a job promptly, with a clear error, when the Codex app-server connection closes mid-turn instead of hanging forever.
- Shut the shared broker down (and tell connected clients why) when its codex app-server exits, so the next command starts a fresh runtime instead of hanging on a zombie broker; interrupt turns whose owning worker disappeared.
- Record worker heartbeats and last-activity timestamps; `/codex:status` shows `Last Activity` and flags runs that have gone quiet as "possibly stalled" (`CODEX_COMPANION_STALL_AFTER_MS`).
- Guard worker processes against silent exits: SIGTERM/SIGINT/SIGHUP, uncaught errors, and a drained event loop all record a failure before the process ends.
- Serialize `state.json` and job-file writes behind a cross-process lock with atomic writes to prevent lost updates and corrupted state.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
