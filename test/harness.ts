import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = join(import.meta.dirname, "..", "dist", "index.js");

/** Spawns the built server over stdio, exactly as Claude Code would, and connects a client. */
export async function startServer(opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: opts.cwd,
    env: { ...(process.env as Record<string, string>), ...opts.env },
    stderr: "inherit",
  });
  const client = new Client({ name: "cheapag-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
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
