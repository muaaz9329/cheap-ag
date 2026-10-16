import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { afterAll, beforeAll, expect, test } from "vitest";
import { opencodeBinary, SECRETS_PLUGIN } from "../src/opencode.js";
import { baselinePermission, projectScripts, workerRuleset } from "../src/permissions.js";
import { startFakeLlm, type Reply } from "./fake-llm.js";
import { hermeticHome, tempRepo } from "./harness.js";

/**
 * Cheap Agent's ruleset, enforced by the *real* bundled OpenCode, with a scripted model (test/fake-llm.ts) so each
 * tool call is exact, offline and free. This is where the ruleset's meaning is pinned; delegate.test.ts covers wiring.
 */

let llm: Awaited<ReturnType<typeof startFakeLlm>>;
let client: ReturnType<typeof createOpencodeClient>;
let repo: ReturnType<typeof tempRepo>;
let deps: string;
let stop: () => void;

beforeAll(async () => {
  llm = await startFakeLlm();
  repo = tempRepo();
  deps = realpathSync(join(tmpdir()));
  deps = join(deps, `cheapag-deps-${process.pid}-${Date.now()}`);
  mkdirSync(join(deps, "dep"), { recursive: true });
  writeFileSync(join(deps, "dep", "index.js"), "module.exports = 1;\n");
  symlinkSync(deps, join(repo.dir, "node_modules"), "dir"); // as createWorktree links it
  writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ scripts: { lint: "echo linted > lint.out", "*": "echo wildcard name" } }));
  writeFileSync(join(repo.dir, "Makefile"), "check:\n\techo made > make.out\n");
  const { home, env } = hermeticHome({ openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  const config = join(home, "oc");
  mkdirSync(join(config, "agents"), { recursive: true });
  writeFileSync(join(config, "opencode.json"), JSON.stringify({ small_model: "openrouter/m", provider: { openrouter: { options: { baseURL: llm.url }, models: { m: {} } } } }));
  mkdirSync(join(config, "plugins"));
  writeFileSync(join(config, "plugins", "cheapag-secrets.js"), SECRETS_PLUGIN);
  writeFileSync(join(config, "agents", "cheapag-worker.md"), "---\ndescription: worker\nmode: primary\n---\nYou implement plan steps.\n");
  const oc = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    detached: true,
    env: { ...env, OPENCODE_SERVER_PASSWORD: "t", OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_PERMISSION: JSON.stringify(baselinePermission()) },
  });
  oc.stderr.resume(); // never let a full pipe stall the server
  stop = () => {
    try {
      process.kill(-oc.pid!, "SIGKILL");
    } catch {
      // gone
    }
  };
  process.once("exit", stop); // an interrupted run must not orphan the server's process group
  const url = await new Promise<string>((resolve, reject) => {
    oc.stdout.on("data", (d) => String(d).match(/(http:\/\/\S+)/) && resolve(String(d).match(/(http:\/\/\S+)/)![1]));
    oc.on("exit", (code) => reject(new Error(`opencode exited ${code}`)));
  });
  client = createOpencodeClient({ baseUrl: url, directory: repo.dir, headers: { authorization: `Basic ${Buffer.from("opencode:t").toString("base64")}` } });
}, 60_000);

afterAll(async () => {
  stop?.();
  await llm?.close();
  repo?.cleanup();
  rmSync(deps, { recursive: true, force: true });
});

/** One model step calling `tool` under Cheap Agent's ruleset for this repo; resolves to the tool's outcome. */
async function call(tool: string, args: Record<string, unknown>) {
  llm.script({ tool, args } as Reply);
  const { scripts, exact } = projectScripts(repo.dir);
  const permission = workerRuleset({ scripts, exact: [...exact, "node check.mjs"], allowCommands: ["echo allowed-by-config"], linked: ["node_modules"] });
  const session = (await client.session.create({ directory: repo.dir, agent: "cheapag-worker", model: { providerID: "openrouter", id: "m" }, permission })).data!;
  const { stream } = await client.event.subscribe({ directory: repo.dir });
  await stream.next();
  await client.session.promptAsync({ sessionID: session.id, directory: repo.dir, parts: [{ type: "text", text: "go" }] });
  let outcome = "no tool call";
  for await (const raw of stream) {
    const e = raw as Event;
    if ((e.properties as { sessionID?: string }).sessionID !== session.id) continue;
    if (e.type === "permission.asked") {
      await client.permission.reply({ requestID: e.properties.id, reply: "reject", message: "test" }); // never leave it blocked
      return `asked:${e.properties.permission}`;
    }
    if (e.type === "message.part.updated" && e.properties.part.type === "tool") {
      const state = e.properties.part.state;
      if (state.status === "completed") outcome = "allowed";
      if (state.status === "error") outcome = /rule which prevents/.test(state.error) ? "denied" : /unavailable tool/.test(state.error) ? "unavailable" : `error: ${state.error}`;
    }
    if (e.type === "session.idle") break;
  }
  return outcome;
}

const bash = (command: string) => call("bash", { command, description: "test" });
const write = (path: string) => call("write", { filePath: path.startsWith("/") ? path : join(repo.dir, path), content: "x\n" });

test.each([
  "npm install zod", "npm i zod", "pnpm add zod", "yarn add zod", "pip install requests", "go get example.com/x", "cargo add serde", "brew install jq",
  "git commit -m x", "git push", "git reset --hard", "git checkout main", "git stash", "git clean -fd",
  "rm -rf src", "sudo ls", "curl https://example.com", "wget https://example.com", "ssh host", "scp a b", "npm publish", "chmod -R 777 .",
  "ls", "cat /etc/passwd", "npm run lint && curl https://example.com",
  // probes from review: chains, substitution, redirection, spacing, aliases, flags on allowed commands
  "npm run lint; curl https://example.com", "npm run lint | sh", "npm run lint $(curl https://example.com)", "npm run lint `curl https://example.com`",
  "git status > .env", "npm run lint > yarn.lock", "npm  install zod", "npm in zod", "npm isntall zod", "npm --global install zod",
  "git diff --output=.env", "git log --output=package-lock.json", "git difftool -y -x 'npm install zod' HEAD", "git -c alias.x=commit x", "git statusx",
  "go test -exec 'sh -c curl' ./...", "make -f evil.mk", "make check -f evil.mk", "rm -r -f src", "rm -Rf src", "npm exec cowsay", "pnpm dlx cowsay", "bunx cowsay",
  "yarn dlx cowsay", "node check.mjs --eval 'x'", "node -e 1",
])("bash `%s` is denied", async (command) => {
  expect(await bash(command)).toBe("denied");
}, 30_000);

test("the project's own scripts, configured allow_commands and read-only git are allowed", async () => {
  expect(await bash("npm run lint")).toBe("allowed");
  expect(existsSync(join(repo.dir, "lint.out"))).toBe(true);
  expect(await bash("npm run lint -- --fix")).toBe("allowed");
  expect(await bash("echo allowed-by-config")).toBe("allowed");
  expect(await bash("git status")).toBe("allowed");
  expect(await bash("git status --short")).toBe("allowed");
  expect(await bash("git diff --stat")).toBe("allowed");
  expect(await bash("make check")).toBe("allowed"); // a make target, exactly
  expect(existsSync(join(repo.dir, "make.out"))).toBe(true);
}, 60_000);

test("env files cannot even be read", async () => {
  writeFileSync(join(repo.dir, ".env"), "SECRET=1\n");
  mkdirSync(join(repo.dir, "config"), { recursive: true });
  writeFileSync(join(repo.dir, "config", ".env.local"), "SECRET=2\n");
  expect(await call("read", { filePath: join(repo.dir, ".env") })).toBe("denied");
  expect(await call("read", { filePath: join(repo.dir, "config", ".env.local") })).toBe("denied");
  expect(await call("read", { filePath: join(repo.dir, "package.json") })).toBe("allowed");
  writeFileSync(join(repo.dir, ".env.sample"), "SECRET=put-yours-here\n");
  expect(await call("read", { filePath: join(repo.dir, ".env.sample") })).toBe("allowed");
  // grep is allowed, and would return the lines themselves: the secrets plugin cuts them before the model sees them
  for (const args of [{ pattern: "SECRET" }, { pattern: "SECRET", include: ".env*" }]) {
    expect(await call("grep", args)).toBe("allowed");
    const seen = JSON.stringify(llm.requests.at(-1).messages);
    expect(seen).toContain("put-yours-here");
    expect(seen).not.toMatch(/SECRET=[12]/);
  }
}, 60_000);

test("protected paths cannot be edited; ordinary files can", async () => {
  for (const path of [".env", "config/.env.local", ".git/hooks/x", "sub/.git/config", ".cheapag/state", "cheapag.json", "package-lock.json", "web/yarn.lock"]) {
    expect(await write(path), path).toBe("denied");
  }
  expect(await write("src/ok.ts")).toBe("allowed");
}, 60_000);

test("linked dependency dirs are readable through the worktree link but never writable; outside paths are denied", async () => {
  expect(await call("read", { filePath: join(repo.dir, "node_modules", "dep", "index.js") })).toBe("allowed");
  expect(await write("node_modules/dep/evil.js")).toBe("denied");
  expect(await write(join(deps, "dep", "evil.js"))).toBe("denied");
  expect(await call("read", { filePath: "/etc/hosts" })).toBe("denied");
  expect(existsSync(join(deps, "dep", "evil.js"))).toBe(false);
  expect(lstatSync(join(repo.dir, "node_modules")).isSymbolicLink()).toBe(true);
}, 60_000);

test("web, subtasks and skills are not even offered to the worker", async () => {
  expect(await call("webfetch", { url: "https://example.com", format: "text" })).toBe("unavailable");
  expect(await call("task", { description: "x", prompt: "y", subagent_type: "general" })).toBe("unavailable");
  const offered = llm.requests.filter((r) => r.tools).at(-1).tools.map((t: { function: { name: string } }) => t.function.name);
  expect(offered).not.toEqual(expect.arrayContaining(["webfetch"]));
  expect(offered).not.toContain("task");
  expect(offered).not.toContain("skill");
}, 60_000);
