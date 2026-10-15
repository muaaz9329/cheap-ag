#!/usr/bin/env node
// `cheapag login` sets up a provider; anything else (including no arguments) runs the MCP server
if (process.argv[2] === "login") process.exit(await (await import("./login.js")).login());
else await (await import("./server.js")).serve();
