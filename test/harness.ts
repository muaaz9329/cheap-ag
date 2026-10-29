import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const serverEntry = join(import.meta.dirname, "..", "dist", "index.js");

/** Scales explicit per-test timeouts (vitest config can't reach these) for Windows CI's ~3x slowness. */
export const slow = (ms: number) => (process.platform === "win32" ? ms * 3 : ms);

/** Removes a temp dir, retrying on Windows; on EBUSY there, dumps the processes still holding it. */
export function removeDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  } catch (err) {
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EBUSY") {
      let holders = "";
      try {
        holders = execFileSync("powershell.exe", ["-NoProfile", "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'opencode|bash|^sh|rg|node|git|conhost|esbuild' } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,CommandLine | Format-List | Out-String -Width 400`
        ]).toString();
      } catch {}
      console.error(`cheapag-test: EBUSY on ${dir}; processes:\n${holders}`);
    }
    throw err;
  }
}

/** Saved logins to seed, provider id → key, e.g. `{ openrouter: "sk-or-…" }`. */
export type Logins = Record<string, string>;

/**
 * A fresh XDG home with its own OpenCode credential store, seeded with `logins` the way `cheapag login` saves them
 * (test-only plumbing, ADR-0004). The env drops the developer's CHEAPAG_OPENCODE_URL and any leftover provider key vars.
 */
export function hermeticHome(logins: Logins = {}) {
  // realpathSync.native expands Windows 8.3 short names; same result on macOS
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-home-")));
  if (Object.keys(logins).length) {
    mkdirSync(join(home, "data", "opencode"), { recursive: true });
    const auth = Object.fromEntries(Object.entries(logins).map(([id, key]) => [id, { type: "api", key }]));
    writeFileSync(join(home, "data", "opencode", "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  }
  return { home, env: homeEnv(home) };
}

/** The CLI env for a hermetic home, e.g. a running server's, to run `allow` or `login` beside it. */
export function homeEnv(home: string) {
  const { OPENCODE_GO_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, CHEAPAG_OPENCODE_URL, ...inherited } = process.env as Record<string, string>;
  return {
    ...inherited,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  };
}

/** Runs the real `cheapag allow <args>` in `cwd`, the way the developer opts a repo in; returns its output. */
export function allowRepo(cwd: string, env: Record<string, string>, args: string[] = []) {
  return execFileSync(process.execPath, [serverEntry, "allow", ...args], { cwd, env, stdio: "pipe" }).toString();
}

/**
 * Spawns the built server over stdio, exactly as Claude Code would, and connects a client.
 * Hermetic (see `hermeticHome`); `cwd` defaults to that home, so `.cheapag/` never lands in this repo.
 * `allow` first opts the cwd's repo in through the real CLI (`[]` = all models), as the developer would.
 */
export async function startServer(opts: { cwd?: string; env?: Record<string, string>; logins?: Logins; nodeArgs?: string[]; allow?: string[] } = {}) {
  const { home, env } = hermeticHome(opts.logins);
  if (opts.allow) allowRepo(opts.cwd ?? home, { ...env, ...opts.env }, opts.allow);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(opts.nodeArgs ?? []), serverEntry],
    cwd: opts.cwd ?? home,
    env: { ...env, ...opts.env },
    stderr: "inherit",
  });
  const client = new Client({ name: "cheapag-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    home,
    pid: transport.pid!,
    close: async () => {
      await client.close();
      // Windows holds handles briefly after a process exits
      removeDir(home);
    },
  };
}

/** Calls a tool and returns its text content joined, which is what Claude reads. */
export async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export type RepoState = "clean" | "dirty" | "untracked";

/** A throwaway git repo with one commit, then left in the requested working-tree state. */
export function tempRepo(state: RepoState = "clean") {
  // realpathSync.native: macOS tmpdir is a /var -> /private/var symlink, and git reports the resolved path; expands 8.3 names on Windows
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-test-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=cheapag-test", "-c", "user.email=test@cheapag.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" }).toString();

  git("init", "-q", "-b", "main");
  // as a set-up repo would be, so results carry no gitignore hint (test/cleanup.test.ts clears this to see it)
  appendFileSync(join(dir, ".git", "info", "exclude"), ".cheapag/\n");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");

  if (state === "dirty") writeFileSync(join(dir, "README.md"), "# fixture\n\nedited\n");
  if (state === "untracked") writeFileSync(join(dir, "notes.txt"), "untracked\n");

  return { dir, git, cleanup: () => removeDir(dir) };
}

/** Every file in a checkout (but .git and .cheapag) with its bytes, plus git's view: index entries and status. Equal snapshots = an untouched tree. */
export function snapshot(dir: string) {
  const files = Object.fromEntries((readdirSync(dir, { recursive: true }) as string[])
    .map((p) => [p, p.split(sep).join("/")] as const)
    .filter(([raw, p]) => !/^\.(git|cheapag)(\/|$)/.test(p) && lstatSync(join(dir, raw)).isFile())
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([raw, p]) => [p, readFileSync(join(dir, raw)).toString("base64")]));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
  return { files, index: git("ls-files", "-s"), status: git("status", "--porcelain", "--untracked-files=all") };
}
