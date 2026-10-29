import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "./credentials.js";
import { baselinePermission } from "./permissions.js";
import { gitBash, killProcessGroup, opencodePlatform } from "./platform.js";
import { fullRoute, modelName, routeModels, type Route } from "./routing.js";

const require = createRequire(import.meta.url);
export const OPENCODE_PIN = (require("opencode-ai/package.json") as { version: string }).version;

/**
 * The binary comes from opencode-ai's platform package, never PATH. We skip opencode-ai/bin because
 * its postinstall (which fills it in) does not run under pnpm or npm's install-scripts gate.
 * shortcut: takes the first installed variant, not the avx2/musl-aware pick postinstall makes; mirror it if x64 baseline users report crashes.
 */
export function opencodeBinary() {
  const { os, binary } = opencodePlatform();
  const base = `opencode-${os}-${arch()}`;
  const fromPkg = createRequire(require.resolve("opencode-ai/package.json"));
  for (const name of [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]) {
    try {
      const bin = join(dirname(fromPkg.resolve(`${name}/package.json`)), "bin", binary);
      if (existsSync(bin)) return bin;
    } catch {
      // variant not installed for this platform
    }
  }
  throw new Error(`no OpenCode binary installed for ${base}; reinstall cheap-agent`);
}

const WORKER_PROMPT = `---
description: Cheap Agent worker. Implements plan steps in an isolated git worktree.
mode: primary
---
You implement the plan step marked >>> CURRENT STEP(S), in this repository, by editing files yourself.
- Stay within the step's files: and make precise edits. If you must edit anything else, report it under risks.
- Never install packages or run install commands. If the step needs a package that is not installed, ask with the question tool, worded exactly: step needs package <name>@<range> (not installed). Install it in the main checkout, then reply "installed", or reply "no" to proceed without. Options: installed, no.
- Never touch .git, .env* files or lockfiles. Never commit.
- If the step is ambiguous or conflicts with its dont:, ask with the question tool instead of guessing.
- When a Source section is given (the user's request or the issue, verbatim), the step is someone's reading of it: check the step against the source before you start. Implement the step as written, but name every point where they disagree (a direction, an order, a value, an approach the source prefers) in finish's disagree. When the source names a preferred approach or links a fix, implement that one and say so in summary.
- If the step fixes a bug or a wrong behaviour, prove it: first write a small test that reproduces the problem and run it to see it fail, then fix the code and run it again to see it pass. Write the test first, before reading widely. When the step names the exact change (the file and the code), make that change first, then write the test. Keep the test in the change, and run it with the same command the step's checks use (e.g. its test runner plus the test file or id).
- The reproduction test asserts the exact values, order and types the source or step states or implies. "Does not crash" or "contains X" is not enough when the expected value is known.
- A command denied by policy is not allowed in this sandbox: a second denial of the same command means stop, do not try variants (quoting, cd, env, other runners); finish and name it under missing.
- When done, call the finish tool exactly once, last: summary (at most 160 chars), risks, review (path:start-end, max 5), missing, repro (the command that runs your reproduction test, "none: <why>" if you could not reproduce it, "n/a" if the step is not a fix), disagree (where the step and the source disagree, or "none").
- If you cannot call finish, end your last message with a fenced cheapag-result block holding the same fields.
`;

// The research worker reports in its final text, not a custom tool: its ruleset stays exactly read, glob, grep, list
const RESEARCH_PROMPT = `---
description: Cheap Agent research worker. Answers questions about this repository, read-only.
mode: primary
---
You answer one question about the code in this repository. You are read-only: you can read, grep, glob and list, nothing else (no edits, no commands, no questions, no web).
- Answer from the code itself, never from memory. Cite what you state as path:line or path:start-end, paths relative to the repository root.
- Stay within the scope and the word limit you are given.
- End your last message with exactly one fenced block:
\`\`\`cheapag-research
status: answer | unsure (the code does not settle the question) | partial (you were stopped before finishing; this is what you found so far)
confidence: high (seen directly in code) | medium (inferred) | low (a guess)
refs: src/a.ts:18-42, src/b.ts:31
answer:
<your answer, in prose, within the word limit>
\`\`\`
`;

// Runs inside OpenCode (Bun). Its input is captured from the event stream, so it only has to exist and validate.
// It imports nothing (OpenCode accepts a plain { description, args, execute } with JSON Schema args), so OpenCode has nothing to install.
export const FINISH_TOOL_SOURCE = `export default {
  description: "Report the step as done. Call exactly once, as your last action.",
  args: {
    summary: { type: "string", maxLength: 160, description: "What you did, at most 160 characters" },
    risks: { type: "array", items: { type: "string" }, description: "Assumptions, unverified conditions, edits outside files:" },
    review: { type: "array", items: { type: "string" }, maxItems: 5, description: "Ranges worth a human look, as path:start-end" },
    missing: { type: "array", items: { type: "string" }, description: "Anything the step asked for that you did not do" },
    repro: { type: "string", description: "The exact command that runs your reproduction test (fails on the original code, passes now); 'none: <why>' if you could not reproduce the problem; 'n/a' if the step is not a fix" },
    disagree: { type: "string", description: "Where the step's spec and the Source you were given disagree (direction, order, value, approach), or 'none'" },
  },
  async execute() {
    return "Reported. Stop now.";
  },
};
`;

/**
 * Runs inside OpenCode (Bun), for every session: grep returns matching lines, and the read deny on .env* does not
 * cover it (proven on 1.19, even with an explicit include: ".env*"), so .env* match blocks are cut from grep output
 * before the model sees them. .env.example and .env.sample stay visible. Glob and list only return names.
 */
export const SECRETS_PLUGIN = `const SECRET = /(^|[\\\\/])\\.env(?!\\.(example|sample)$)[^\\\\/]*$/;

export const CheapagSecrets = async () => ({
  "tool.execute.after": async (input, output) => {
    if (input.tool !== "grep" || typeof output.output !== "string") return;
    let file = "";
    let hidden = 0;
    const kept = [];
    for (const line of output.output.split("\\n")) {
      const header = line.match(/^(\\S.*):$/);
      if (header) file = header[1];
      else if (line === "") file = "";
      if (SECRET.test(file)) {
        if (header) hidden++;
        continue;
      }
      kept.push(line);
    }
    if (hidden) output.output = kept.join("\\n") + "\\n(" + hidden + " .env file(s) hidden by cheapag)";
  },
});
`;

/** Cheap Agent's own OpenCode config dir: worker and research agents, finish tool, secrets plugin, model pins and options. */
export function writeConfigDir(dir: string, config: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });
  mkdirSync(join(dir, "plugins"), { recursive: true });
  // node_modules + package-lock.json listing @opencode-ai/plugin make OpenCode skip its npm install of it into this dir (core/src/npm.ts); neither generated file imports it
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ name: "cheapag-opencode", lockfileVersion: 3, requires: true, packages: { "": { dependencies: { "@opencode-ai/plugin": OPENCODE_PIN } } } }),
  );
  writeFileSync(join(dir, "agents", "cheapag-worker.md"), WORKER_PROMPT);
  writeFileSync(join(dir, "agents", "cheapag-research.md"), RESEARCH_PROMPT);
  writeFileSync(join(dir, "tools", "finish.ts"), FINISH_TOOL_SOURCE);
  writeFileSync(join(dir, "plugins", "cheapag-secrets.js"), SECRETS_PLUGIN);
  writeFileSync(join(dir, "opencode.json"), config);
}

/** The generated opencode.json for the route's models: their options (e.g. OpenRouter routing) and the small model. */
function opencodeConfig(provider: Provider, route: Route) {
  // the key itself stays in OpenCode's own credential store; the config never names one
  const models = Object.fromEntries(routeModels(route).filter((m) => m.options).map((m) => [m.id, { options: m.options }]));
  const providerConfig = Object.keys(models).length ? { models } : {};
  const config = {
    $schema: "https://opencode.ai/config.json",
    // OpenCode otherwise sends title generation to its own default small model, i.e. another provider the user never chose;
    // the route's implement model is always an allowlisted one
    small_model: modelName(route.implement),
    provider: Object.keys(providerConfig).length ? { [provider.provider]: providerConfig } : {},
  };
  return JSON.stringify(config, null, 2) + "\n";
}

export type Opencode = { url: string; password: string; version: string };

let started: Promise<Opencode> | undefined;
let child: ChildProcess | undefined;
/** The config the running server was booted with. */
let booted: string | undefined;

/**
 * Starts (once per process, until stopOpencode) or attaches to the OpenCode server and checks it runs the pinned version.
 * Its generated config lives in `<projectDir>/.cheapag/opencode/`; projectDir only matters on the call that boots.
 * `route` is a job's allowlisted models; OpenCode reads their options only at boot, so a job whose config differs reboots it.
 * Without one (ping, login) any running server will do.
 */
let holds = 0;

/** Marks the server in use for a job's or research call's lifetime, so a config change never reboots it under them. Returns the release. */
export function holdOpencode() {
  holds++;
  let held = true;
  return () => {
    if (held) holds--;
    held = false;
  };
}

/** The running server, if one is up; never boots one. */
export async function runningOpencode(): Promise<Opencode | undefined> {
  try {
    return await started;
  } catch {
    return undefined; // a failed boot leaves nothing to reach
  }
}

export function ensureOpencode(provider: Provider, projectDir = process.cwd(), route?: Route): Promise<Opencode> {
  const config = opencodeConfig(provider, route ?? fullRoute(provider.provider));
  if (started && route && booted !== config) {
    // a reboot would kill every live session: refuse it while any job or research call holds the server
    // shortcut: one server per config would let both run; worth it only if config changes mid-session become common
    if (holds > 0) return Promise.reject(new Error("the model configuration changed (consent or cheapag.json models) while jobs are running; retry once they finish"));
    stopOpencode();
  }
  if (!started) booted = config;
  started ??= boot(projectDir, config).catch((err) => {
    stopOpencode();
    started = undefined;
    throw err;
  });
  return started;
}

async function boot(projectDir: string, config: string): Promise<Opencode> {
  const configDir = join(projectDir, ".cheapag", "opencode");
  writeConfigDir(configDir, config);
  const external = process.env.CHEAPAG_OPENCODE_URL;
  const password = (external && process.env.CHEAPAG_OPENCODE_PASSWORD) || randomBytes(24).toString("base64url");
  const url = external || (await spawnServer(configDir, password));

  const res = await fetch(new URL("/global/health", url), {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`opencode health check at ${url} answered ${res.status}`);
  const { version } = (await res.json()) as { version: string };
  if (version !== OPENCODE_PIN) {
    throw new Error(`opencode version ${version}, expected ${OPENCODE_PIN}; reinstall cheap-agent`);
  }
  return { url, password, version };
}

function spawnServer(configDir: string, password: string) {
  // on Windows point the worker at Git Bash, so it runs and parses its commands as bash, like the rest of cheapag
  const bash = process.platform === "win32" ? gitBash() : undefined;
  return new Promise<string>((resolve, reject) => {
    // detached: its own process group, so stopOpencode() also takes down anything it spawned
    const proc = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      detached: true,
      // a detached console child would open a window on Windows
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        // OpenCode watches each session dir's .git; cheapag uses none of its events, and on Windows the open handle blocks removing the worktree
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
        ...(bash ? { SHELL: bash } : {}),
        // the server-wide baseline; each worker session also carries the full ruleset, which wins (src/permissions.ts)
        OPENCODE_PERMISSION: JSON.stringify(baselinePermission()),
      },
    });
    child = proc;
    let output = "";
    let listening = false;
    const timer = setTimeout(() => fail(new Error("opencode serve did not start within 15s")), 15_000);
    const fail = (err: Error) => {
      clearTimeout(timer);
      stopOpencode();
      reject(err);
    };
    // keep draining both pipes for the server's lifetime (a full pipe blocks it), but only buffer until it listens
    proc.stderr!.on("data", (chunk) => listening || (output += chunk));
    proc.stdout!.on("data", (chunk) => {
      if (listening) return;
      output += chunk;
      const match = output.match(/opencode server listening on (http:\/\/\S+)/);
      if (match) {
        listening = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on("error", fail);
    proc.on("exit", (code) => {
      if (listening) {
        // a crash after startup: forget the dead server so the next call boots a fresh one. An old server exiting
        // after a reboot is not this boot's failure: it must never stop the server that replaced it.
        if (child === proc) started = child = undefined;
      } else fail(new Error(`opencode serve exited (${code}): ${output.trim().slice(-500)}`));
    });
  });
}

/**
 * Stops the OpenCode server's whole process group. Seen on 1.19.0: a SIGTERM shortly after boot, while it is still
 * busy, can be ignored for good, so a SIGKILL follows if it is still there after a grace period. On process exit
 * (`exiting`) there is no later: it is killed outright (its SQLite WAL survives that).
 */
export function stopOpencode(exiting = false) {
  started = undefined; // the next ensureOpencode boots afresh
  const proc = child;
  child = undefined;
  if (proc?.exitCode !== null || !proc.pid) return;
  if (exiting) return killProcessGroup(proc.pid, "SIGKILL");
  killProcessGroup(proc.pid);
  setTimeout(() => proc.exitCode === null && killProcessGroup(proc.pid, "SIGKILL"), STOP_GRACE_MS).unref();
}

const STOP_GRACE_MS = 3_000;
