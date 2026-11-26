# Bundle a pinned OpenCode instead of using the user's installation

cheapag depends on an exact version of the `opencode-ai` npm package and always runs that binary as its own `opencode serve`, driven through `@opencode-ai/sdk` at the same exact version. It never uses an `opencode` found on `PATH`. The SDK and its event and permission APIs are mid-migration and released in lockstep with the CLI, so a version mismatch is the most likely "works on my machine" failure once strangers install the project. Pinning removes it and means users have nothing to install separately. The cost is a one-time download of about 30–100 MB, and a second OpenCode copy on machines that already have one. Logins are not duplicated, because every OpenCode binary reads the same `~/.local/share/opencode/auth.json`. Keys can also be supplied through `OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY`.

## Consequences

- Upgrading OpenCode is a deliberate cheapag release: bump both pins, run the fake-server and live smoke tests.
- cheapag's server sets `OPENCODE_DISABLE_PROJECT_CONFIG` and its own config dir, so a target repo's `opencode.json` cannot loosen the worker's permissions.
