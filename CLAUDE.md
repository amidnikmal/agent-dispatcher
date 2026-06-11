# Agent Dispatcher

This project provides MCP tools for delegating tasks to CLI agents (Kilo, Codex).

## MCP Tools

- `delegate_kilo` — delegate a task to Kilo (`kilocode run`)
- `delegate_codex` — delegate a task to Codex (`codex-throne exec --skip-git-repo-check`)

## Usage

Call the tools from this project's MCP server. Both tools accept:

- `prompt` (string, required) — the task for the agent
- `cwd` (string, required) — absolute path of a linked git worktree
- `timeout_sec` (number, default 1800, max 7200)
- `log_tail_lines` (number, default 60)

The server validates that `cwd` is a linked git worktree. If it is not, the call is rejected with a clear error message.

## Response Format

Each tool returns a JSON object:

```json
{
  "agent": "kilo",
  "exit_code": 0,
  "duration_s": 12.3,
  "branch": "wt-task-name",
  "diffstat": "src/file.ts | 10 ++++",
  "log_path": "/path/to/logs/kilo-2026-01-01T00-00-00.000Z.log",
  "stdout_tail": "...",
  "stderr_tail": "..."
}
```

## Workflow

1. Orchestrator (Claude Code) thinks/plans
2. Orchestrator calls `delegate_kilo` or `delegate_codex` with a specific task
3. Agent works in the specified worktree
4. Orchestrator receives the JSON report
5. Orchestrator reviews `diffstat` and decides to accept/reject

## Constraints

- Worktree required: `cwd` must be a linked worktree, not a main checkout
- No recursion: `AGENT_DISPATCHER_CHILD=1` is set in agent processes
- Max 3 parallel agents (env: `MAX_PARALLEL=3`)
- Agents cannot run concurrently in the same worktree
- Timeout: SIGTERM after `timeout_sec`, SIGKILL 10 seconds later
