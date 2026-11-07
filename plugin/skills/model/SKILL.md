---
name: model
description: Choose the worker's main and fallback models, each with an effort, from the models your provider offers
disable-model-invocation: true
allowed-tools: Bash(npx -y cheap-agent@1.3.2 model) Bash(npx -y cheap-agent@1.3.2 model *)
---

!`npx -y cheap-agent@1.3.2 model --list`

The developer ran this model command themselves; its output is above. Set the worker's models with them:

1. Ask one question for the main model (it writes the code): the 4 suggestions as the options, and "Other" for any other model id from the provider's catalog.
2. If the picked model lists efforts, ask one question for its effort, with `default` first.
3. Ask one question for the fallback model (used on a rate limit): `none` first, then the suggestions. If it lists efforts, ask for its effort too.
4. Run `npx -y cheap-agent@1.3.2 model --main <id> [--effort <e>] [--fallback <id|none>] [--fallback-effort <e>]` once, leaving out the flags for `default` efforts, and report its last line.

Always show the user this line, as is: `For more models, exit Claude/Codex and run: npx cheap-agent model`

Only because the user invoked this skill: If no output appears above (Codex): run `npx -y cheap-agent@1.3.2 model --list` yourself once, exactly as written. It needs network for npx; ask for that if the sandbox blocks it. Do not change the models in any other way.
