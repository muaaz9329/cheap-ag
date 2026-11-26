# Cheap models run behind an MCP server, not as Claude Code subagents

Claude Code subagents can only run Claude models, and their tokens count against the same subscription limits as the main conversation. They save context, not usage. `ANTHROPIC_BASE_URL` applies to the whole process, and Anthropic does not support routing Claude Code to non-Claude models, so a subagent cannot be pointed at DeepSeek or Qwen while the main session stays on the subscription. We therefore put the cheap worker behind an MCP server (`cheapag`). Claude calls it like any other tool, and the server drives the cheap model with the user's own OpenCode Go or DeepSeek credentials. This keeps the subscription in ordinary use: the unmodified Claude Code plus a user-installed integration, with no proxying or reuse of Claude OAuth tokens.

## Considered Options

- **Subagents with `CLAUDE_CODE_SUBAGENT_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` pointed at a cheap model.** Not supported, and the setting covers the whole process.
- **claude-code-router-style proxy.** It would have to pass the subscription's OAuth bearer through a third-party proxy, which is a terms-of-service grey zone.
- **A second headless `claude -p` process against DeepSeek's Anthropic-compatible endpoint.** Workable, but Anthropic does not support it, and it ties the worker to Claude Code's internals.
