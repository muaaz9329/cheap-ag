# Cheap Agent plugin for Claude Code

Gives Claude the Cheap Agent MCP server (`delegate`, `research`, `reply`, `jobs`, `land`), the plan-writing skill, `/cheapag:status`, and the user-only commands `/cheapag:allow`, `/cheapag:clean` and `/cheapag:hook`.

## Worker models

`npx cheap-agent login` asks which worker models to use, after the provider. Each preset picks the implement and escalation models for your provider (OpenCode Go, OpenRouter or DeepSeek):

- **cheapest**: the lowest worker spend. Claude takes over more often when the worker fails.
- **balanced** (the default): the preset the benchmark measured and recommends.
- **strongest**: the strongest cheap models, for when you would rather pay the worker than have Claude take over.

Measured on SWE-bench Verified (OpenRouter): Flash's worker cost is about $0.005 per easy task and $0.03 per hard one; GLM-5.3 costs about $0.06 on the hard ones, and there Claude used 1.5x fewer tokens than with Flash, because GLM-5.3's failures cost Claude less to recover from. On the hard tier alone GLM-5.3 showed no gain, so `balanced` keeps Flash everywhere and `strongest` (GLM-5.3 for every task) is opt-in. `cheapest` is the same as `balanced` today.

The choice goes into `models` in `~/.config/cheapag/config.json`. Run `npx cheap-agent login --preset <cheapest|balanced|strongest>` to switch without the prompts. `ping` and `cheapag status` show it as `preset=<name>`. For a finer choice, set `models` (`implement`, `research`, `escalation`, `fallback`, as full `provider/model` names) in a repo's `cheapag.json`, which overrides the user config, or in the user config itself; answering `custom` (or `--preset custom`) makes login leave it as you wrote it. Changing the models after `/cheapag:allow` makes the next job ask for it again, with the new list.

## What it costs to keep in context

Everything Claude Code loads at session start is sent again on every turn: the system prompt, tool definitions, every enabled skill's description, plugin instructions and CLAUDE.md. A bigger prefix means each turn costs more, and a prefix that changes between sessions is rewritten at full price instead of read from cache. Measured on a real machine (Claude Code 2.1.285), a session that only answers "OK" cost $0.10 with ~100 user plugins and skills enabled, against $0.02–0.04 with only what the task needs.

- **Disable plugins you are not using** (`/plugin` → disable). Each enabled plugin adds its skills and instructions to every turn of every session.
- **Mark skills you only call by name** with `disable-model-invocation: true` in their `SKILL.md` frontmatter. Their descriptions then stay out of the context. Cheap Agent's `allow`, `clean` and `hook` already do this.
- **Keep CLAUDE.md under ~200 lines.** It is part of every turn. Move rarely needed detail into files Claude reads on demand.
- **Pin the Claude Code version** (`DISABLE_AUTOUPDATER=1`) during long stretches of work. An update changes the system prompt, so the next session rewrites the whole cached prefix.
- **For scripted runs** (`claude -p`): `--setting-sources project` skips user plugins and settings, and `--exclude-dynamic-system-prompt-sections` keeps per-machine details (cwd, git status) out of the cached prefix. The `includeGitInstructions: false` setting drops the commit/PR boilerplate when the agent never commits.

`cheapag status` prints the prefix size of this repo's most recent Claude Code session, when its transcript is readable (`claude prefix: 18.4k tokens on the first turn …`). Under ~20k is lean; 40k+ usually means plugins or skills the work doesn't use.

## Sessions, `/clear` and the cache TTL

Claude Code caches the session prefix. Every turn that starts within the cache's lifetime reads it at a tenth of the input price, instead of writing it again at more than the input price. How you split work into sessions decides how often you pay the full write.

- **One session per block of work.** Starting a fresh `claude` for every small task writes the whole prefix each time. Inside a session it is written once and then read.
- **`/clear` between unrelated tasks.** It's free: the prefix stays cached, and only the conversation is dropped. It also keeps old, unrelated context from distracting Claude on the next task.
- **Pick the TTL for how you work.** The default 1-hour cache suits all-day work with pauses. For short bursts of back-to-back tasks, `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` makes cache writes cheaper ($5 instead of $8 per million tokens on Opus), as long as you never idle more than five minutes. After a longer pause, the next turn rewrites the prefix.
- `cheapag status` shows the last session's cache use: `claude cache: 14 requests, 91% of input from cache, 1h TTL`. A low percentage on a long session means the prefix kept changing (plugins toggled, an update, idle gaps past the TTL).

On a Pro or Max plan these are dollar estimates at API prices. Anthropic says cached tokens count less toward plan limits, but publishes no ratio.
