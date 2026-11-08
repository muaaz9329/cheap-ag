#!/usr/bin/env node
// `cheapag login` (or no arguments in a terminal) sets up a provider and Claude Code, `cheapag allow` records the repo's consent, `cheapag model` picks the worker's main and fallback models, `cheapag provider` switches between providers already set up, `cheapag clean` tidies .cheapag/, `cheapag status` reports jobs and spend, `cheapag watch` tails them live, `cheapag hook` toggles or runs the edit guard, `cheapag codex` runs the server with Codex instructions; anything else (including no arguments) runs the MCP server
// `npx cheap-agent` typed in a terminal is setup (ticket 31); Claude Code starts the server with no arguments and a piped stdin
if (process.argv[2] === "login" || (process.argv[2] === undefined && process.stdin.isTTY)) process.exit(await (await import("./login.js")).login(process.argv.slice(3), { setup: process.argv[2] === undefined }));
else if (process.argv[2] === "allow") process.exit((await import("./allow.js")).allow(process.argv.slice(3)));
else if (process.argv[2] === "model") process.exit(await (await import("./model.js")).model(process.argv.slice(3)));
else if (process.argv[2] === "provider") process.exit(await (await import("./provider.js")).provider(process.argv.slice(3)));
else if (process.argv[2] === "clean") process.exit((await import("./cleanup.js")).clean(process.argv.slice(3)));
else if (process.argv[2] === "status") process.exit((await import("./status.js")).status(process.argv.slice(3)));
else if (process.argv[2] === "watch") {
  const ids = process.argv.slice(3).filter((arg) => !arg.startsWith("-"));
  const live = await import("./watch.js");
  process.exit(ids.length ? await live.follow((await import("./workspace.js")).projectRoot(process.cwd()), ids) : await live.watch());
}
else if (process.argv[2] === "hook") process.exit(await (await import("./hook.js")).hook(process.argv.slice(3)));
else if (process.argv[2] === "codex") await (await import("./server.js")).serve("codex");
else await (await import("./server.js")).serve();
