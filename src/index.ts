#!/usr/bin/env node
// `cheapag login` sets up a provider, `cheapag allow` records the repo's consent, `cheapag clean` tidies .cheapag/, `cheapag status` reports jobs and spend; anything else (including no arguments) runs the MCP server
if (process.argv[2] === "login") process.exit(await (await import("./login.js")).login());
else if (process.argv[2] === "allow") process.exit((await import("./allow.js")).allow(process.argv.slice(3)));
else if (process.argv[2] === "clean") process.exit((await import("./cleanup.js")).clean(process.argv.slice(3)));
else if (process.argv[2] === "status") process.exit((await import("./status.js")).status(process.argv.slice(3)));
else await (await import("./server.js")).serve();
