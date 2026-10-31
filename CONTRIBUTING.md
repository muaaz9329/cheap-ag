# Contributing to Cheap Agent

Thanks for wanting to help! Bug fixes, new providers, docs, and benchmark runs are all welcome. I'm more than happy to merge your PR.

## Before you start

- **Small fix or typo?** Open a PR straight away.
- **Bigger change (a new feature, a change to how jobs run or land)?** Open an issue first so we can agree on the shape before you spend time on it.
- **Found a bug?** Open an issue with what you ran, what you expected, and what happened. The output of `/cheapag:status` helps a lot.

## Setup

You need Node.js 20.11+ and git.

```bash
git clone https://github.com/muaaz9329/cheap-ag.git
```

```bash
cd cheap-ag && npm install
```

```bash
npm test
```

`npm test` builds first, then runs the whole suite with fake models, so it costs nothing and needs no API key. `npm run typecheck` checks types without building.

The live test calls a real model and spends real (tiny) money. It only runs when you ask for it:

```bash
CHEAPAG_LIVE=1 OPENROUTER_API_KEY=<your key> npx vitest run test/live.test.ts
```

CI runs the suite on Ubuntu and Windows, so keep paths and shell commands cross-platform (`src/platform.ts` has the helpers).

## Where things live

| Path | What it does |
|---|---|
| `src/server.ts` | The MCP server: the `research`, `delegate`, `jobs`, `land` and `reply` tools Claude sees |
| `src/jobs.ts` | A job's life: run the worker, run the checks, the fail-without-fix repro check, the verdict |
| `src/workspace.ts` | The isolated git worktree each job runs in |
| `src/plan.ts` | The plan file format (`files:`, `do:`, `done-when:`) |
| `src/routing.ts` | Providers, model presets, and which model handles which difficulty |
| `src/opencode.ts`, `src/worker.ts` | Starting the bundled OpenCode and driving the worker |
| `src/permissions.ts`, `src/consent.ts` | What the worker may touch, and which repos and models the user allowed |
| `src/hook.ts` | The Claude Code hooks that stop Opus redoing the worker's checks |
| `plugin/` | The Claude Code plugin: skills, hooks, MCP config |
| `docs/adr/` | Why the big decisions were made. Read these before changing the design |
| `bench/` | The SWE-bench and token benchmarks |

## Adding a provider

[PR #1](https://github.com/muaaz9329/cheap-ag/pull/1) (Command Code) is a good example to copy:

1. Add it to the provider list in `src/credentials.ts`.
2. Add its presets and model roles in `src/routing.ts`.
3. Add its OpenCode config in `src/opencode.ts` if it isn't built into OpenCode.
4. Add tests in `test/routing.test.ts` and `test/opencode.test.ts`.
5. Add it to the provider list in the README.

## Pull requests

- **One change per PR.** Small PRs get merged fast.
- **Behaviour changes come with a test**, ideally one that fails without your change. That's the same rule the worker follows.
- **Commit messages** follow the style in `git log`: `feat(routing): ...`, `fix(jobs): ...`, `docs(readme): ...`.
- **Don't bump the version.** I do that when I release.
- **Safety rules need an issue first.** Consent (`/cheapag:allow`), the worker never reading `.env` or committing, and keys only via `cheapag login` exist on purpose. Changes there get discussed before code.

Using Cheap Agent to build Cheap Agent is welcome. Most of it was built that way.

## License

By contributing, you agree your work is released under the [MIT License](./LICENSE).
