# Security

## What this plugin does

`codex-delegate-mcp` spawns the **OpenAI Codex CLI** (`codex exec`) in your workspace with
approval policy `never`. Agent-mode tasks can modify, create, or delete files under the
chosen `workspace` directory (Codex sandbox: `workspace-write`).

Treat every `delegate` call like handing an engineer write access to that tree. Your MCP
host (Claude Code, etc.) is the orchestrator: it should scope the brief, then review
`filesReportedByEditTools` and the git diff. That field lists only what Codex's edit tool
reported touching — files written by a shell command it ran are not in it, so the diff is
what actually changed.

## Running several at once

Delegations run concurrently, and that is only safe across **disjoint workspaces**. Two agents
writing one tree overwrite each other, and the git diff cannot say which one did what. Starting a
delegation while another is running in the same directory, or in one that contains it, adds a
warning to the result — but the warning arrives once both are already running, so the time to
separate them is when you write the briefs.

## The brief

The brief is written to Codex's stdin, not passed as a command-line argument, so it is not
readable by other processes on the machine (`/proc/*/cmdline` on Linux, WMI or Process Explorer on
Windows). This matters because the delegate skill tells the orchestrator to quote the user's exact
values verbatim.

`review` is the exception: its target flags rule out a positional prompt, so its brief still
travels in the command line. Keep secrets out of a review brief.

## Recommendations

- Point `workspace` at the smallest directory that holds the task's files — never `$HOME`, a
  filesystem root, or a directory created for the call. With no such directory, the project root
  is the floor; inventing a narrower one does not scope the run, it just moves it somewhere Codex
  cannot do the work.
- Review `filesReportedByEditTools` and the git diff before committing.
- Use `mode: "plan"` or `mode: "ask"` when you do not want writes.
- Give concurrent delegations disjoint workspaces.
- Codex runs **connected by default**. Pass `network: false` to seal a run — no web search, no
  shell egress. Worth doing whenever the workspace holds content you did not write, since an agent
  that can both read your repo and reach the network is what turns a prompt injection into an
  exfiltration.
- Run verification (tests, lint) after delegation — the delegate skill asks the host to do this.

## Reporting vulnerabilities

Email the maintainer listed in `package.json`. Do not file a public issue with exploit details.
