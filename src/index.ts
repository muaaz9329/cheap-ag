#!/usr/bin/env node
// `cheapag login` (or no arguments in a terminal) sets up a provider and Claude Code, `cheapag allow` records the repo's consent, `cheapag model` picks the worker's main and fallback models, `cheapag provider` switches between providers already set up, `cheapag clean` tidies .cheapag/, `cheapag status` reports jobs and spend, `cheapag watch` tails them live, `cheapag hook` toggles or runs the edit guard, `cheapag codex` runs the server with Codex instructions; anything else (including no arguments) runs the MCP server
const command = process.argv[2];
const args = process.argv.slice(3);

// `npx cheap-agent` typed in a terminal is setup; Claude Code starts the server with no arguments and a piped stdin
if (command === "login" || (command === undefined && process.stdin.isTTY))
  process.exit(await (await import("./login.js")).login(args, { setup: command === undefined }));
else if (command === "allow") process.exit((await import("./allow.js")).allow(args));
else if (command === "model") process.exit(await (await import("./model.js")).model(args));
else if (command === "provider") process.exit(await (await import("./provider.js")).provider(args));
else if (command === "clean") process.exit((await import("./cleanup.js")).clean(args));
else if (command === "status") process.exit((await import("./status.js")).status(args));
else if (command === "watch") {
  const ids = args.filter((arg) => !arg.startsWith("-"));
  const live = await import("./watch.js");
  process.exit(
    ids.length
      ? await live.follow((await import("./workspace.js")).projectRoot(process.cwd()), ids)
      : await live.watch(),
  );
} else if (command === "hook") process.exit(await (await import("./hook.js")).hook(args));
else if (command === "codex") await (await import("./server.js")).serve("codex");
else await (await import("./server.js")).serve();
