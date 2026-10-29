---
name: clean
description: Remove Cheap Agent's old worktrees and job logs now; --all removes everything not in flight.
argument-hint: "[--all]"
disable-model-invocation: true
allowed-tools: Bash(npx -y cheap-agent@1.1.0 clean) Bash(npx -y cheap-agent@1.1.0 clean *)
---

!`npx -y cheap-agent@1.1.0 clean $ARGUMENTS`

Report the result above to the user in one or two lines.
