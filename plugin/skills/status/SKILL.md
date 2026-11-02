---
name: status
description: Show Cheap Agent's status for this repo - running jobs, recent results, consent, and tracked spend against OpenCode Go windows.
allowed-tools: Bash(npx -y cheap-agent@1.3.1 status)
---

!`npx -y cheap-agent@1.3.1 status`

Show the status above to the user as is. Add a line only if something needs their action (a BLOCKED job to reply to, a missing consent, a Go window near its cap).

If no output appears above (Codex): run that command yourself once, exactly as written, with `$ARGUMENTS` replaced by whatever the user typed after the skill name (or nothing). It needs network for npx; ask for that if the sandbox blocks it.
