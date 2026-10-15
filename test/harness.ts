import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = join(import.meta.dirname, "..", "dist", "index.js");

/**
 * Spawns the built server over stdio, exactly as Claude Code would, and connects a client.
 * Hermetic: a fresh XDG home (no OpenCode login), no worker keys or URL from the developer's shell.
 * `cwd` defaults to that home, so `.cheapag/` never lands in this repo.
 */
export async function startServer(opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cheapag-home-")));
  const { OPENCODE_GO_API_KEY, DEEPSEEK_API_KEY, CHEAPAG_OPENCODE_URL, ...inherited } = process.env as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: opts.cwd ?? home,
    env: {
      ...inherited,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      ...opts.env,
    },
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
      rmSync(home, { recursive: true, force: true });
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
  // realpath: macOS tmpdir is a /var -> /private/var symlink, and git reports the resolved path
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cheapag-test-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=cheapag-test", "-c", "user.email=test@cheapag.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" }).toString();

  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");

  if (state === "dirty") writeFileSync(join(dir, "README.md"), "# fixture\n\nedited\n");
  if (state === "untracked") writeFileSync(join(dir, "notes.txt"), "untracked\n");

  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
