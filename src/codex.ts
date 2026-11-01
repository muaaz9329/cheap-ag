#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { configureCodex } from "./runtime.js";

configureCodex();
if (process.argv[2] === "login") {
  // Provider login only: never run the Claude plugin installer or hooks.
  const { opencodeBinary } = await import("./opencode.js");
  const result = spawnSync(opencodeBinary(), ["auth", "login", ...process.argv.slice(3)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else if (process.argv[2] === "allow") process.exit((await import("./allow.js")).allow(process.argv.slice(3)));
else if (process.argv[2] === "clean") process.exit((await import("./cleanup.js")).clean(process.argv.slice(3)));
else if (process.argv[2] === "status") process.exit((await import("./status.js")).status(process.argv.slice(3)));
else if (process.argv[2]) { process.stderr.write("usage: cheapcode [login | allow | clean | status]\n"); process.exit(1); }
else await (await import("./server.js")).serve();
