# Cheap Agent (cheapag)

Cheap Agent lets Claude plan and review while a cheaper model does the implementation and codebase exploration, so heavy work stays off Claude's usage limits.

## Language

### Planning

**Plan**:
A markdown file, written once, that breaks a feature into numbered steps for the worker to execute.
_Avoid_: Spec, task list

**Step**:
One numbered unit of work inside a plan, with the files it touches and a checkable done condition.
_Avoid_: Task, stage

### Execution

**Worker**:
The cheap model plus the coding agent driving it, which executes steps by editing files itself.
_Avoid_: Subagent (reserved for Claude Code's own subagents), coder, executor

**Job**:
One execution of one or more steps by the worker, identified by a short id.
_Avoid_: Task, run, delegation

**Turn**:
One tool call the worker makes inside a job.
_Avoid_: Step, iteration

**Group**:
A set of steps executed together, in order, by one job; independent groups may run in parallel.
_Avoid_: Batch, chunk

**Landing**:
Applying a job's isolated changes onto the user's working tree.
_Avoid_: Merging, applying, syncing

**Redo**:
A follow-up job that re-applies a group's change onto updated code after its landing hit a conflict.
_Avoid_: Rebase, retry

**Self-fix**:
The worker's own retry within a job, driven by the failing verification output, before anything is reported to Claude.
_Avoid_: Retry, repair

**Escalation**:
A job's final self-fix attempt made with a stronger (still cheap) model.
_Avoid_: Upgrade, fallback

**Integration check**:
Running the verification commands on the combined code after every group in a delegation has landed.
_Avoid_: Final test, post-merge check

### Reporting

**Result block**:
The compact, status-first text Claude receives when a job ends or pauses.
_Avoid_: Response, output, report
