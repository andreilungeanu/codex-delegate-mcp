# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-16

### Fixed

- Prefer `turn.failed` over exit-code ambiguity when classifying run status
- Make process kill and PATH lookup injectable so cancel/resolver tests do not hang on Windows

### Tests

- Expanded unhappy-path coverage: empty spec, network/mode conflicts, resume+review, timeouts, plan schema requirements, fail-closed finals, cancel ownership, invalid model/live probes
- Live smoke (`docs/live-smoke.mjs`) verified ask/plan/agent/review/resume/cancel against Codex CLI 0.144.4

## [1.0.0] - 2026-07-16

### Added

- Lean MCP worker bridge for OpenAI Codex CLI (`codex exec --json`)
- Tools: `delegate`, `cancel`, `doctor`
- Modes: `agent`, `plan`, `ask`, and native `review`
- Fail-closed final answers via `--output-last-message`
- Concurrent cancel with single-flight operation registry
- Git-based `touchedFiles` when the workspace is a repo
- Claude / Codex / Copilot-oriented install docs and delegate skill
