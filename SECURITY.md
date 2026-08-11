# Security

## What this plugin does

`codex-delegate-mcp` spawns the **OpenAI Codex CLI** (`codex exec`) in your workspace and
**auto-approves every command it runs** (`--dangerously-bypass-approvals-and-sandbox`), in
every mode — `agent`, `plan`, `ask` and `review`.

Delegated tasks can create, modify, or delete files anywhere your user account can reach, and
reach the network. `webSearch: false` turns off Codex's web search tool only; the worker's
shell has network access regardless. Codex's sandbox modes are not used: on Windows they run
commands under a restricted token that cannot start child processes, so tests and build tools
fail under them.

Treat every `delegate` call like handing an engineer a shell on your machine.
Your MCP host (Claude Code, etc.) is the orchestrator: it should scope the brief, then review
`filesReportedByEditTools` and the git diff. That field lists only what Codex's edit tool
reported touching — files written by a shell command it ran are not in it, and neither is
anything written outside the workspace, so the diff is not a complete record either.

## Running several at once

Delegations run concurrently. Give them **disjoint workspaces** — necessary, though not
sufficient, since `workspace` is the worker's working directory and not a wall it cannot cross.
Two agents writing one tree overwrite each other, and the git diff cannot say which did what. Starting a
delegation while another is running in the same directory, or in one that contains it, adds a
warning to the result — but the warning arrives once both are already running, so the time to
separate them is when you write the briefs.

## The brief

The brief goes down Codex's stdin rather than its command line, so it does not show up in
`/proc/*/cmdline` on Linux or Process Explorer on Windows. That is not the same as private:
Codex writes the whole thread to `~/.codex/sessions`, which anything running as you can read.
The delegate skill tells the orchestrator to quote the user's exact values, so keep credentials
out of a brief.

`review` is the exception: its target flags rule out a positional prompt, so its brief still
travels in the command line. Keep secrets out of a review brief.

## Recommendations

- Point `workspace` at the smallest directory that holds the task's files — never `$HOME`, a
  filesystem root, or a directory created for the call. With no such directory, the project root
  is the floor; inventing a narrower one does not scope the run, it just moves it somewhere Codex
  cannot do the work.
- Review `filesReportedByEditTools` and the git diff before committing.
- Do not rely on `mode: "plan"` or `mode: "ask"` to prevent writes. They do not. No mode does.
- Give concurrent delegations disjoint workspaces.
- Codex runs **connected**, and `webSearch: false` does not change that — it turns off web search
  only. There is no way to cut the worker's shell off from the network. An agent that can both
  read your repo and reach the network is what turns a prompt injection into an exfiltration, so
  do not point a delegation at content you did not write.
- Run verification (tests, lint) after delegation — the delegate skill asks the host to do this.

## Reporting vulnerabilities

Email the maintainer listed in `package.json`. Do not file a public issue with exploit details.
