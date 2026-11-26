import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, onTestFinished, test, vi } from "vitest";
import { instructions } from "../src/server.js";
import { hermeticHome, removeDir, serverEntry, slow, startServer, tempRepo } from "./harness.js";

test("an unknown first argument runs the MCP server with the claude instructions", async () => {
  for (const argument of ["--help", "constructor"]) {
    const server = await startServer({ args: [argument] });
    onTestFinished(server.close);
    expect(server.client.getInstructions()).toBe(instructions());
  }
});

test(
  "cheapag watch with only flags tails the repo's jobs, as with no arguments",
  async () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    const child = spawn(process.execPath, [serverEntry, "watch", "--ignored-flag", "-x"], {
      cwd: repo.dir,
    });
    onTestFinished(() => void child.kill());
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const jobs = join(repo.dir, ".cheapag", "jobs");
    await vi.waitFor(() => expect(out).toBe(`watching ${jobs} (Ctrl-C to stop)\n`), slow(10_000));
    expect(child.exitCode).toBeNull(); // still watching
  },
  slow(30_000),
);

/** The command modules that the MCP server does not import itself (it does import cleanup.js). */
const CLI_MODULES = ["allow.js", "hook.js", "login.js", "model.js", "provider.js", "status.js"];

/** The dist modules a `cheapag <args>` run loaded, recorded by a module load hook. */
function loadedModules(args: string[]): string[] {
  const { home, env } = hermeticHome();
  onTestFinished(() => removeDir(home));
  const hook = join(home, "record-loads.mjs");
  writeFileSync(
    hook,
    [
      'import { appendFileSync } from "node:fs";',
      'import { registerHooks } from "node:module";',
      "const { CHEAPAG_TEST_DIST: dist, CHEAPAG_TEST_LOADED: log } = process.env;",
      "registerHooks({",
      "  load(url, context, nextLoad) {",
      '    if (url.startsWith(dist)) appendFileSync(log, url.slice(dist.length) + "\\n");',
      "    return nextLoad(url, context);",
      "  },",
      "});",
    ].join("\n"),
  );
  const log = join(home, "loaded.txt");
  writeFileSync(log, "");
  const dist = `${pathToFileURL(dirname(serverEntry)).href}/`;
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(hook).href, serverEntry, ...args],
    {
      cwd: home,
      env: { ...env, CHEAPAG_TEST_DIST: dist, CHEAPAG_TEST_LOADED: log },
      input: "", // the server exits when stdin ends
      encoding: "utf8",
      timeout: slow(30_000),
    },
  );
  expect(run.error).toBeUndefined();
  return readFileSync(log, "utf8").trim().split("\n");
}

test.skipIf(!("registerHooks" in nodeModule))(
  "each command loads only its own module: the MCP server never loads a CLI command, and a CLI command never loads the server",
  () => {
    const server = loadedModules([]);
    expect(server).toContain("index.js");
    expect(server).toContain("server.js");
    for (const name of CLI_MODULES) expect(server).not.toContain(name);

    const status = loadedModules(["status", "--x"]);
    expect(status).toContain("status.js");
    const otherCommands = CLI_MODULES.filter((name) => name !== "status.js");
    for (const name of ["server.js", "cleanup.js", ...otherCommands])
      expect(status).not.toContain(name);
  },
  slow(60_000),
);
