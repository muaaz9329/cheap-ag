# Cheap Agent plugin for Claude Code

Gives Claude the Cheap Agent MCP server (`delegate`, `research`, `reply`, `jobs`, `land`), the plan-writing skill, `/cheapag:status`, and the user-only commands `/cheapag:allow`, `/cheapag:clean` and `/cheapag:hook`.

## What it costs to keep in context

Everything Claude Code loads at session start is sent again on every turn: the system prompt, tool definitions, every enabled skill's description, plugin instructions and CLAUDE.md. A bigger prefix means each turn costs more, and a prefix that changes between sessions is rewritten at full price instead of read from cache. Measured on a real machine (Claude Code 2.1.285), a session that only answers "OK" cost $0.10 with ~100 user plugins and skills enabled, against $0.02–0.04 with only what the task needs.

- **Disable plugins you are not using** (`/plugin` → disable). Each enabled plugin adds its skills and instructions to every turn of every session.
- **Mark skills you only call by name** with `disable-model-invocation: true` in their `SKILL.md` frontmatter. Their descriptions then stay out of the context. Cheap Agent's `allow`, `clean` and `hook` already do this.
- **Keep CLAUDE.md under ~200 lines.** It is part of every turn. Move rarely needed detail into files Claude reads on demand.
- **Pin the Claude Code version** (`DISABLE_AUTOUPDATER=1`) during long stretches of work. An update changes the system prompt, so the next session rewrites the whole cached prefix.
- **For scripted runs** (`claude -p`): `--setting-sources project` skips user plugins and settings, and `--exclude-dynamic-system-prompt-sections` keeps per-machine details (cwd, git status) out of the cached prefix. The `includeGitInstructions: false` setting drops the commit/PR boilerplate when the agent never commits.

`cheapag status` prints the prefix size of this repo's most recent Claude Code session, when its transcript is readable (`claude prefix: 18.4k tokens on the first turn …`). Under ~20k is lean; 40k+ usually means plugins or skills the work doesn't use.
