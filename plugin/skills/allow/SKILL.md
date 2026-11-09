---
name: allow
description: Opt this repository in to sending code to Cheap Agent's worker models - all models, --zdr-only (zero-retention only), or --models provider/model,...
argument-hint: "[--zdr-only | --models provider/model,...]"
disable-model-invocation: true
allowed-tools: Bash(npx -y cheap-agent@1.4.1 allow) Bash(npx -y cheap-agent@1.4.1 allow *)
---

!`npx -y cheap-agent@1.4.1 allow $ARGUMENTS`

The developer ran this consent command themselves; its output is above. Report it in one line.

Only because the user invoked this skill: If no output appears above (Codex): run that command yourself once, exactly as written, with `$ARGUMENTS` replaced by whatever the user typed after the skill name (or nothing). It needs network for npx; ask for that if the sandbox blocks it. Do not run `cheapag allow` again or change consent in any other way.
