# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-16

### Added

- Lean MCP worker bridge for OpenAI Codex CLI (`codex exec --json`)
- Tools: `delegate`, `cancel`, `doctor`
- Modes: `agent`, `plan`, `ask`, and native `review`
- Fail-closed final answers via `--output-last-message`
- Concurrent cancel with single-flight operation registry
- Git-based `touchedFiles` when the workspace is a repo
- Claude / Codex / Copilot-oriented install docs and delegate skill
