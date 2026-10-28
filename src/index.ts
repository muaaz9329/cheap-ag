#!/usr/bin/env node
// `cheapag login` (or no arguments in a terminal) sets up a provider and Claude Code, `cheapag allow` records the repo's consent, `cheapag clean` tidies .cheapag/, `cheapag status` reports jobs and spend, `cheapag hook` toggles or runs the edit guard; anything else (including no arguments) runs the MCP server
// `npx cheap-agent` typed in a terminal is setup (ticket 31); Claude Code starts the server with no arguments and a piped stdin
if (process.argv[2] === "login" || (process.argv[2] === undefined && process.stdin.isTTY)) process.exit(await (await import("./login.js")).login(process.argv.slice(3)));
else if (process.argv[2] === "allow") process.exit((await import("./allow.js")).allow(process.argv.slice(3)));
else if (process.argv[2] === "clean") process.exit((await import("./cleanup.js")).clean(process.argv.slice(3)));
else if (process.argv[2] === "status") process.exit((await import("./status.js")).status(process.argv.slice(3)));
else if (process.argv[2] === "hook") process.exit((await import("./hook.js")).hook(process.argv.slice(3)));
else await (await import("./server.js")).serve();
