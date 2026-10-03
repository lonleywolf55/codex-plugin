---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

The command checks every active job against the machine before reporting: a job whose worker process has exited, crashed, or was killed is reported as `failed` with an explanation instead of staying "running" forever. Each active job also carries a `Last Activity` value; a job that has been quiet for longer than the stall threshold is flagged as "possibly stalled" together with a warning line.

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, last activity, summary, and follow-up commands.
- If any job carries a stall warning or an error, keep that text so the user sees it.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
- With `--wait`, the command blocks until the job finishes or `--timeout-ms` elapses (default 4 minutes), and returns early if the job's worker dies. If the output still shows the job as active after the wait, say so and offer `/codex:status <job-id> --wait` again or `/codex:cancel <job-id>`.
