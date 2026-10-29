---
name: hook
description: Turn Cheap Agent's edit guard on or off for this repo - when on, Claude's large edits (or a 3rd edit to one file in a turn) are denied and redirected to delegate.
argument-hint: "[on | off]"
disable-model-invocation: true
allowed-tools: Bash(npx -y cheap-agent@1.0.0 hook) Bash(npx -y cheap-agent@1.0.0 hook *)
---

!`npx -y cheap-agent@1.0.0 hook $ARGUMENTS`

The developer ran this command themselves; its output is above. Report it in one line. Do not turn the edit guard on or off in any other way.
