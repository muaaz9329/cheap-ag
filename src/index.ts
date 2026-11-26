#!/usr/bin/env node
// `cheapag login` (or no arguments in a terminal) sets up a provider and Claude Code,
// `cheapag allow` records the repo's consent,
// `cheapag model` picks the worker's main and fallback models,
// `cheapag provider` switches between providers already set up,
// `cheapag clean` tidies .cheapag/,
// `cheapag status` reports jobs and spend,
// `cheapag watch` tails them live,
// `cheapag hook` toggles or runs the edit guard,
// `cheapag codex` runs the server with Codex instructions;
// anything else (including no arguments) runs the MCP server.
// Each branch imports its module only when it runs: the MCP server starts without the
// CLI-only modules (login, model, ...), and a CLI command starts without the server.
const command = process.argv[2];
const args = process.argv.slice(3);

// `npx cheap-agent` typed in a terminal is setup; Claude Code starts the server with no arguments and a piped stdin
if (command === "login" || (command === undefined && process.stdin.isTTY)) {
  const { login } = await import("./login.js");
  process.exit(await login(args, { setup: command === undefined }));
} else if (command === "allow") {
  const { allow } = await import("./allow.js");
  process.exit(allow(args));
} else if (command === "model") {
  const { model } = await import("./model.js");
  process.exit(await model(args));
} else if (command === "provider") {
  const { provider } = await import("./provider.js");
  process.exit(await provider(args));
} else if (command === "clean") {
  const { clean } = await import("./cleanup.js");
  process.exit(clean(args));
} else if (command === "status") {
  const { status } = await import("./status.js");
  process.exit(status(args));
} else if (command === "watch") {
  const ids = args.filter((arg) => !arg.startsWith("-"));
  const { follow, watch } = await import("./watch.js");
  if (ids.length) {
    const { projectRoot } = await import("./workspace.js");
    process.exit(await follow(projectRoot(process.cwd()), ids));
  } else {
    process.exit(await watch());
  }
} else if (command === "hook") {
  const { hook } = await import("./hook.js");
  process.exit(await hook(args));
} else if (command === "codex") {
  const { serve } = await import("./server.js");
  await serve("codex");
} else {
  const { serve } = await import("./server.js");
  await serve();
}
