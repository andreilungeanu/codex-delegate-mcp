---
name: delegate
description: >
  Ask OpenAI Codex for its view or hand it coding work through the codex-delegate-mcp
  delegate tool. Use when the user says ask Codex what it thinks, get Codex's opinion or a
  second opinion, delegate or hand off to Codex, plan or review with Codex, or resume a
  Codex thread. Do not shell out to codex.
---

# Delegate to Codex

Call the codex-delegate-mcp `delegate` tool; never run `codex` from the shell.

## Write the brief

`spec` carries the whole task, inline:

- **Goal**: the outcome, precisely.
- **Scope**: the files and directories in play. Point at files to read or follow rather than
  pasting code.
- **Decisions**: what the user already settled, in their exact words.
- **Done when**: verifiable acceptance criteria, and the tests to run while it works. For `ask` and
  `plan`, the form and length of the answer.
- End by asking Codex to report any criterion it could not meet and any assumption it made.

`workspace` is the smallest existing directory that holds the task's files.

## Ask and compare

`mode: "ask"` answers a question or gives a second opinion. Codex receives the brief unchanged,
so say in it that you want an answer and no edits. To compare models, send the same
brief in parallel calls, one `model` per call or another plugin's `delegate` tool, then set the
answers side by side with your own view. Check the claims that matter before relaying them.

## Hand off the work

- `agent` implements.
- `plan` returns a structured `plan`. Present it, wait for approval, then resume the thread in
  `agent` mode with `resumeThreadId`, the same `workspace` and a `spec` such as "implement the
  approved plan" plus any changes.
- `review` runs Codex's native review over one `reviewTarget`; put the focus in `spec`. A review
  cannot be resumed.

Parallel runs that write need separate directories; otherwise run them one after another.
Silence mid-turn is normal while Codex runs a command or reasons.

## After the run

1. `result` counts only when `status` is `completed`. Read `warnings` when present.
2. Read the git diff after every run, whatever the mode, and run the tests yourself when files
   changed. `filesReportedByEditTools` misses files written by shell commands.
3. If a criterion fails on a sound approach, resume the thread (`threadId`) with the specific failure
   and the same `workspace`. For a wrong approach, or after two failed resumes, start a new
   thread with a rewritten brief. `resumed: false` means the context did not carry over: send
   the full brief on the returned `threadId`.
4. Report what changed and which criteria pass.

An unfamiliar `reason` or field is explained in [reference.md](reference.md).
