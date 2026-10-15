import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "./credentials.js";

const require = createRequire(import.meta.url);
export const OPENCODE_PIN = (require("opencode-ai/package.json") as { version: string }).version;

/**
 * The binary comes from opencode-ai's platform package, never PATH. We skip opencode-ai/bin because
 * its postinstall (which fills it in) does not run under pnpm or npm's install-scripts gate.
 * shortcut: takes the first installed variant, not the avx2/musl-aware pick postinstall makes; mirror it if x64 baseline users report crashes.
 */
function opencodeBinary() {
  const os = platform() === "win32" ? "windows" : platform();
  const base = `opencode-${os}-${arch()}`;
  const fromPkg = createRequire(require.resolve("opencode-ai/package.json"));
  for (const name of [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]) {
    try {
      const bin = join(dirname(fromPkg.resolve(`${name}/package.json`)), "bin", os === "windows" ? "opencode.exe" : "opencode");
      if (existsSync(bin)) return bin;
    } catch {
      // variant not installed for this platform
    }
  }
  throw new Error(`no OpenCode binary installed for ${base}; reinstall cheap-agent`);
}

/** Cheap Agent's own OpenCode config dir. Keys stay in env; config only names the variable. */
function writeConfigDir(dir: string, provider: Provider) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });
  const providerConfig =
    provider.via === "login" ? {} : { [provider.provider]: { options: { apiKey: `{env:${provider.via}}` } } };
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: providerConfig }, null, 2) + "\n");
}

export type Opencode = { url: string; password: string; version: string };

let started: Promise<Opencode> | undefined;
let child: ChildProcess | undefined;

/** Starts (once) or attaches to the OpenCode server and checks it runs the pinned version. */
export function ensureOpencode(provider: Provider): Promise<Opencode> {
  started ??= boot(provider).catch((err) => {
    stopOpencode();
    started = undefined;
    throw err;
  });
  return started;
}

async function boot(provider: Provider): Promise<Opencode> {
  const configDir = join(process.cwd(), ".cheapag", "opencode");
  writeConfigDir(configDir, provider);
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
  return new Promise<string>((resolve, reject) => {
    // detached: its own process group, so stopOpencode() also takes down anything it spawned
    const proc = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
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
      // a crash after startup: forget the dead server so the next call boots a fresh one
      if (listening && child === proc) started = child = undefined;
      else fail(new Error(`opencode serve exited (${code}): ${output.trim().slice(-500)}`));
    });
  });
}

export function stopOpencode() {
  if (child?.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // group already gone
    }
  }
  child = undefined;
}
