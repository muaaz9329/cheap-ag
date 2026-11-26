# Worker credentials come only from `cheapag login`, never from environment variables

Cheap Agent gets provider keys (OpenCode Go, OpenRouter, DeepSeek) only from saved logins in OpenCode's credential store, written by `cheapag login`, which runs the bundled OpenCode's own login with hidden input. Environment-variable keys such as `OPENROUTER_API_KEY` are deliberately not supported. The developer wanted exactly one setup path. The usual ways of supplying env keys leak them: shell profiles, `claude mcp add -e`, which writes plain text to `~/.claude.json`, and pasting into chat, which enters the transcript. A single login that also live-checks the key and registers the server with Claude Code makes onboarding one command. Cheap Agent stores no secrets of its own.

## Consequences

- CI or headless use needs a saved login on that machine (or a seeded OpenCode credential store). There's no env-var shortcut.
- The test harness and live tests seed the hermetic OpenCode credential store directly. That's test-only plumbing, not a product path.
- Every "no credentials" failure points to `npx cheap-agent login`.
