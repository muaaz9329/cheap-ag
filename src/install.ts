import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userConfigFile } from "./config.js";
import { firstLine, normalisePath, runCli, which } from "./platform.js";

/**
 * The Claude Code plugin (hooks and slash commands), installed by setup. It is generated from this package's
 * own plugin/ so it always matches the installed version, needs no public marketplace, and leaves out .mcp.json (setup
 * registers the server at user scope). Its hooks run on every tool call once a job has run, so they call a launcher that
 * starts this install with node (~0.1 s) instead of npx (~0.4 s), falling back to npx if this install is gone.
 */

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const PLUGIN_SOURCE = fileURLToPath(new URL("../plugin", import.meta.url));
const NPX_COMMAND = `npx -y cheap-agent@${version}`;
export const MARKETPLACE = "cheapag";

/** Where setup keeps the launcher and the generated marketplace: next to the user config. */
export const installPaths = () => {
  const home = dirname(userConfigFile());
  return { launcher: join(home, "bin", "cheapag.cjs"), marketplace: join(home, "marketplace") };
};

/**
 * The launcher every hook and command runs as `node <launcher> <args>`. Windows has no /bin/sh, so one CommonJS file
 * runs on every platform: it gates the guard hook (exit 0 unless the repo opted in), then runs this install when it is
 * still there, else the pinned npx.
 */
function launcherScript(entry: string) {
  return `// cheapag: gates the guard hook, runs this install, else the fallback npx -y cheap-agent@${version}
"use strict";
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const entry = ${JSON.stringify(entry)};
if (process.argv[2] === "hook" && process.argv[3] === "guard") {
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    process.exit(0);
  }
  if (!existsSync(join(root, ".cheapag", "hook.json")) && !existsSync(join(root, ".cheapag", "hook", "takeover"))) process.exit(0);
}
if (existsSync(entry)) {
  process.argv[1] = entry;
  import(pathToFileURL(entry).href);
} else {
  const r = spawnSync("npx", ["-y", "cheap-agent@${version}", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(r.status ?? 1);
}
`;
}

/**
 * How hooks and commands run the launcher. Windows commands run in Git Bash or PowerShell, so they take double quotes
 * and forward slashes; POSIX keeps single quotes.
 */
function launcherCommand(launcher: string, platform: NodeJS.Platform) {
  if (platform === "win32") return `node "${normalisePath(launcher)}"`;
  return `node '${launcher}'`;
}

/** Replaces the pinned npx command in `file` with the launcher command. */
function replaceNpxCommand(file: string, command: string) {
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(NPX_COMMAND, command));
}

/** Writes the launcher and the plugin's marketplace; returns the marketplace directory. */
export function writePlugin(
  entry: string,
  _node: string,
  platform: NodeJS.Platform = process.platform,
) {
  const { launcher, marketplace } = installPaths();
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, launcherScript(entry));
  const command = launcherCommand(launcher, platform);

  rmSync(marketplace, { recursive: true, force: true });
  const plugin = join(marketplace, "cheapag");
  cpSync(PLUGIN_SOURCE, plugin, { recursive: true });
  rmSync(join(plugin, ".mcp.json"), { force: true });
  for (const skill of readdirSync(join(plugin, "skills"))) {
    replaceNpxCommand(join(plugin, "skills", skill, "SKILL.md"), command);
  }
  const hooksFile = join(plugin, "hooks", "hooks.json");
  if (platform === "win32") {
    // rewrite the commands as JSON: a raw replace would put unescaped double quotes inside the strings; no sh prefix, since the launcher gates and exits 0
    const json = JSON.parse(readFileSync(hooksFile, "utf8"));
    const hookCommand = (action: string) => `${command} hook ${action}`;
    json.hooks.PreToolUse[0].hooks[0].command = hookCommand("guard");
    json.hooks.PostToolUse[0].hooks[0].command = hookCommand("result");
    json.hooks.SessionStart[0].hooks[0].command = hookCommand("context");
    writeFileSync(hooksFile, JSON.stringify(json, null, 2) + "\n");
  } else {
    replaceNpxCommand(hooksFile, command);
  }
  mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: MARKETPLACE,
        owner: { name: "muaaz9329" },
        description: "Cheap Agent, generated by its setup from the installed package",
        plugins: [
          {
            name: "cheapag",
            source: "./cheapag",
            description: "Claude plans, a cheap model writes the code",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  return marketplace;
}

/** Generates the plugin and adds it to Claude Code (or updates it); prints the manual commands when a step fails. */
export function installPlugin(
  out: (line?: string) => void,
  { update = false }: { update?: boolean } = {},
): boolean {
  const marketplace = writePlugin(realpathSync(process.argv[1]), stableNode());
  const claude = (...args: string[]) => runCli("claude", ["plugin", ...args], { encoding: "utf8" });
  const listed = (args: string[], name: string) => (claude(...args)?.stdout ?? "").includes(name);
  const steps = [
    listed(["marketplace", "list"], MARKETPLACE)
      ? ["marketplace", "update", MARKETPLACE]
      : ["marketplace", "add", marketplace],
    listed(["list"], `cheapag@${MARKETPLACE}`)
      ? ["update", `cheapag@${MARKETPLACE}`]
      : ["install", `cheapag@${MARKETPLACE}`],
  ];
  for (const step of steps) {
    const r = claude(...step);
    if (!r || r.status !== 0) {
      out(`✗ claude plugin ${step.join(" ")} failed (${firstLine(r)}). Run these yourself:`);
      out(
        `  claude plugin marketplace add ${marketplace}\n  claude plugin install cheapag@${MARKETPLACE}`,
      );
      return false;
    }
  }
  out(
    update
      ? `✓ Updated the cheapag plugin to ${version}`
      : "✓ Added the cheapag plugin to Claude Code (its /cheapag commands and hooks)",
  );
  return true;
}

/** A `node` on PATH resolving to this same binary (e.g. Homebrew's bin symlink) survives upgrades; the versioned execPath doesn't. */
export function stableNode() {
  const self = realpathSync(process.execPath);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = which("node", process.platform, { PATH: dir, PATHEXT: process.env.PATHEXT });
    try {
      if (candidate && realpathSync(candidate) === self) return candidate;
    } catch {} // vanished between lookup and realpath
  }
  return process.execPath;
}
