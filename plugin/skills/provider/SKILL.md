---
name: provider
description: Switch the worker to another provider you have already set up (no key prompt); this repo's consent moves with it
argument-hint: "[provider id]"
disable-model-invocation: true
allowed-tools: Bash(npx -y cheap-agent@1.3.2 provider) Bash(npx -y cheap-agent@1.3.2 provider *)
---

!`npx -y cheap-agent@1.3.2 provider $ARGUMENTS`

The developer ran this provider command themselves; its output is above.

- If it listed the providers set up (no provider was given), ask the user one question: which provider to use, with the listed ones as the options (the one in use marked). Then run `npx -y cheap-agent@1.3.2 provider <id>` once and report its last lines.
- If it switched or failed, report it in one or two lines, including any consent line and fix it printed.

A provider that is not set up needs a key: tell the user to exit and run `npx cheap-agent login` in a terminal. Never ask for or handle a key.

Only because the user invoked this skill: If no output appears above (Codex): run `npx -y cheap-agent@1.3.2 provider $ARGUMENTS` yourself once, exactly as written, with `$ARGUMENTS` replaced by whatever the user typed after the skill name (or nothing). It needs network for npx; ask for that if the sandbox blocks it. Do not change the provider or consent in any other way.
