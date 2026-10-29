# Every job runs in a git worktree with dependency folders symlinked in

Every job, even a single group, runs in its own git worktree under `.cheapag/worktrees/`, and only `OK` jobs are landed into the user's working tree. This gives one code path for single and parallel groups, never touches the user's uncommitted work until landing, and lets failed or partial work be discarded cleanly. The uncommitted state, including a freshly written plan, is copied into each new worktree. A fresh worktree has no untracked dependency folders, so `node_modules`, `.venv`, `vendor` and similar are **symlinked** from the main checkout instead of being installed per job. To keep those shared folders safe, install commands are hard-denied for the worker. A step that needs a new package turns into a `BLOCKED` question, and the package is installed in the main checkout.

## Considered Options

- **Run a setup command (`npm ci`) in each worktree.** Fully isolated, but 30 s to minutes and extra disk per job.
- **Edit the main working tree directly for single groups.** Faster, but two code paths, and it needs a guard against clobbering uncommitted edits.

## Consequences

- Symlinks are POSIX-specific. On Windows, directory junctions are used instead, isolated in the platform module.
- Scripts that write into dependency folders (e.g. `node_modules/.cache`) still write to the shared copy. This is tolerated and documented.
