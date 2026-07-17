# Privacy

Codex Delegate MCP runs as a local stdio MCP server. The project author does not operate a backend for the plugin and does not receive your code, prompts, workspace contents, session identifiers, diagnostics, or usage telemetry.

When you delegate, the local server starts the OpenAI Codex CLI. Task prompts, selected workspace content, model requests, and account usage are handled under OpenAI / Codex terms. Your MCP host may separately process the prompt and tool results under its own terms.

The MCP response can contain file paths, agent output, plan text, diagnostic information, and thread identifiers. Review that output before sharing logs or bug reports. The plugin does not redact secrets found in prompts, files, agent output, or diagnostics.
