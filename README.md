# Cheap Agent

**Make your Claude Code plan last longer.** Claude stays in charge: it understands what you want, plans the change and tells you the result. A cheap model (DeepSeek by default) writes the code in a private copy of your project, proves it with a test, and only working changes come back. Claude spends its tokens thinking, not typing.

## Install (one command)

```bash
npx cheap-agent
```

It asks three things and does the rest:

1. **Which provider runs the cheap model.** Pick **OpenRouter** if you're unsure.
2. **Which models.** Press Enter for the recommended one.
3. **Your API key.** It's typed into a hidden prompt and stored on your computer; Claude never sees it.

Then it checks the key works and adds Cheap Agent to Claude Code for all your projects.

**Then, in each project:** open a new Claude Code session and type `/cheapag:allow` once. That's your OK to send that project's code to the cheap model. After that, just ask Claude for changes as you normally would.

### What you need first

- [Claude Code](https://claude.com/claude-code)
- [Node.js](https://nodejs.org) 20 or newer (the LTS download is fine)
- An API key with a few dollars of credit, from one of:
  - [OpenRouter](https://openrouter.ai/keys) (recommended)
  - [DeepSeek](https://platform.deepseek.com)
  - [OpenCode Go](https://opencode.ai)

  A typical task costs the cheap model under one cent.
- macOS or Linux. On Windows, use WSL.

## What it saves

Measured on [SWE-bench Verified](https://www.swebench.com) (real bugs from real open-source projects) and on a small app, against plain Claude Code (Opus) doing the same tasks:

| kind of task | Claude (Opus) tokens | tasks solved |
|---|---|---|
| A feature in existing code (expense tracker: budgets + CSV export) | **2.7x fewer** | same (both pass all tests) |
| Everyday bug fixes (7 SWE-bench tasks) | **2.4x fewer** | same (7 of 7) |
| The hardest bugs (9 SWE-bench tasks) | **3x fewer**, plus Sonnet doing the cleanup | a little lower (5 of 9 vs 7 of 9) |
| Tiny tasks (a few lines, or a whole small app from nothing) | no saving | same |

When the cheap model can't finish a step, a Sonnet helper finishes it instead of Opus. Sonnet uses your plan's allowance much more slowly than Opus. Results vary by about 20% from run to run, so try it on your own work.

## Everyday use

You don't need to do anything differently. Claude sends code changes to the cheap model and reports back. Useful commands inside Claude Code:

| command | what it does |
|---|---|
| `/cheapag:allow` | give your OK for this project (once per project) |
| `/cheapag:status` | see recent jobs and what the cheap model has cost |
| `/cheapag:hook on` | make Claude *always* hand code changes to the cheap model in this project |
| `/cheapag:clean` | tidy up old job folders |

**Your changes are never committed for you.** They land in your project uncommitted, so you review the diff as usual.

## Privacy

- Code from a project goes to the provider you picked, and only after you run `/cheapag:allow` there. `/cheapag:allow` shows exactly which models get it.
- Your API key stays on your computer, in the bundled OpenCode's own credential store. It's never put in chat, in environment variables or in Claude's context.
- With OpenRouter, how long your code is kept depends on the model's host. Cheap Agent asks OpenRouter to avoid hosts that train on your data.

## Settings (optional)

Put a `cheapag.json` in a project to change its behaviour, for example:

```json
{ "takeover": "self" }
```

| setting | default | meaning |
|---|---|---|
| `takeover` | `"sonnet"` | who finishes a step the cheap model couldn't: a Sonnet helper, or `"self"` (Opus, at most 15 tool calls) |
| `limits.max_turns` | `25` | the most turns the cheap model gets per step |
| `models` | from setup | which cheap models to use; rerun `npx cheap-agent login --preset strongest` to switch |

## Update or remove

- **Update:** run `npx cheap-agent@latest` again.
- **Remove:**

  ```bash
  claude plugin uninstall cheapag@cheapag
  ```

  ```bash
  claude mcp remove -s user cheapag
  ```

## License

[Elastic License 2.0](./LICENSE): free for anyone, individuals and companies, to use, change and share. You may not offer it to others as a hosted or managed service.
