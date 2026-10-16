---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --cwd "<workspace>" --background --json "<task text>"`

Execution rules:
- Invoke `task` exactly once, then deliver the complete final report using the same job ID, explicit `--cwd` and `CLAUDE_PLUGIN_DATA` throughout.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review` or `cancel`. Use `status` and `result --final` for the launched job only.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` launch.
- Prompt drafting and same-job result retrieval are the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, strip that routing flag from the task text. Always add runtime `--background --json`; the routing flag only controls whether Claude waits for this subagent.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Final report delivery:
- Retain the launch receipt's exact `jobId`. Call `status <job-id> --cwd "<workspace>" --wait --timeout-ms 30000 --brief --json` until terminal. A `waitTimedOut: true` response is a successful bounded wait, not failure or completion; keep waiting on that same ID without launching another task.
- If status is `failed` or `cancelled`, report that status and its error with the exact ID. Do not claim completion.
- Once `completed`, call `result <job-id> --cwd "<workspace>" --final --offset 0 --json`. This projects only the authoritative `storedJob.result.rawOutput`, not progress, the request, a summary or duplicated rendered output.
- Each JSON response contains `jobId`, `offset`, `nextOffset`, `totalLength`, `done` and `text`. Retrieve the next slice at `nextOffset` until `done: true`. Check that the ID and offsets remain continuous; concatenate all `text` values in order, without inserting characters. These offsets are JavaScript string offsets supplied by the runtime; do not calculate them yourself.
- Return the concatenated final report verbatim only after the final slice arrives. If a tool paginates even a bounded slice, retrieve that call's remaining pages through the actually available pagination tool before parsing it.
- A missing or blank final report is an error. Surface any launch, wait or retrieval failure, including stderr and the exact job ID when available. Never silently return nothing, relaunch a duplicate job or hand back progress as a completed review.

Safety rules:
- Default to write-capable Codex work unless the user explicitly asks for read-only behavior, review, diagnosis or research without edits.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, solve the request yourself or add independent analysis. Prompt shaping and same-job final-report delivery are the only Claude-side work.
