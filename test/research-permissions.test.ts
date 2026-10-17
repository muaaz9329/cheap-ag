import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { afterAll, beforeAll, expect, test } from "vitest";
import { opencodeBinary, writeConfigDir } from "../src/opencode.js";
import { baselinePermission, researchRuleset } from "../src/permissions.js";
import { RESEARCH_AGENT } from "../src/research.js";
import { startFakeLlm, type Reply } from "./fake-llm.js";
import { hermeticHome, tempRepo } from "./harness.js";

/**
 * The research worker is strictly read-only, as enforced by the *real* bundled OpenCode (scripted model, see
 * test/permissions.test.ts): its own agent and session ruleset, run in the main checkout itself.
 */

let llm: Awaited<ReturnType<typeof startFakeLlm>>;
let client: ReturnType<typeof createOpencodeClient>;
let repo: ReturnType<typeof tempRepo>;
let status: string;
let stop: () => void;

beforeAll(async () => {
  llm = await startFakeLlm();
  repo = tempRepo("dirty"); // README.md has an uncommitted edit
  writeFileSync(join(repo.dir, ".env"), "SECRET=1\n");
  mkdirSync(join(repo.dir, "config"));
  writeFileSync(join(repo.dir, "config", ".env.local"), "SECRET=2\n");
  writeFileSync(join(repo.dir, ".env.example"), "SECRET=put-yours-here\n");
  status = repo.git("status", "--porcelain", "--untracked-files=all");
  const { home, env } = hermeticHome({ openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  const config = join(home, "oc");
  // Cheap Agent's real config dir (agents included), minus the finish tool: loading it would install a package
  writeConfigDir(config, JSON.stringify({ small_model: "openrouter/m", provider: { openrouter: { options: { baseURL: llm.url }, models: { m: {} } } } }));
  rmSync(join(config, "tools"), { recursive: true });
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
});

/** One model step calling `tool` as the research worker; resolves to the tool's outcome (and output, when allowed). */
async function call(tool: string, args: Record<string, unknown>) {
  llm.script({ tool, args } as Reply);
  const session = (await client.session.create({ directory: repo.dir, agent: RESEARCH_AGENT, model: { providerID: "openrouter", id: "m" }, permission: researchRuleset() })).data!;
  const { stream } = await client.event.subscribe({ directory: repo.dir });
  await stream.next();
  await client.session.promptAsync({ sessionID: session.id, directory: repo.dir, parts: [{ type: "text", text: "go" }] });
  let outcome = "no tool call";
  let output = "";
  for await (const raw of stream) {
    const e = raw as Event;
    if ((e.properties as { sessionID?: string }).sessionID !== session.id) continue;
    if (e.type === "permission.asked") {
      await client.permission.reply({ requestID: e.properties.id, reply: "reject", message: "test" }); // never leave it blocked
      return { outcome: `asked:${e.properties.permission}`, output };
    }
    if (e.type === "question.asked") {
      await client.question.reject({ requestID: e.properties.id });
      return { outcome: "asked:question", output };
    }
    if (e.type === "message.part.updated" && e.properties.part.type === "tool") {
      const state = e.properties.part.state;
      if (state.status === "completed") [outcome, output] = ["allowed", state.output];
      if (state.status === "error") outcome = /rule which prevents/.test(state.error) ? "denied" : /unavailable tool/.test(state.error) ? "unavailable" : `error: ${state.error}`;
    }
    if (e.type === "session.idle") break;
  }
  return { outcome, output };
}

const outcome = async (tool: string, args: Record<string, unknown>) => (await call(tool, args)).outcome;
const blocked = (o: string) => ["denied", "unavailable"].includes(o);

test("reads the main checkout, uncommitted edits included, and searches it", async () => {
  const read = await call("read", { filePath: join(repo.dir, "README.md") });
  expect(read.outcome).toBe("allowed");
  expect(read.output).toContain("edited");
  expect(await outcome("glob", { pattern: "**/*.md" })).toBe("allowed");
  expect(await outcome("grep", { pattern: "fixture" })).toBe("allowed");
  // 1.19 has no separate list tool (`list` stays allowed for the rule's sake): read lists a directory
  expect(await outcome("read", { filePath: join(repo.dir, "config") })).toBe("allowed");
  // exactly the read-only tools are offered to the model
  expect(llm.requests.filter((r) => r.tools).at(-1).tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual(["bash", "glob", "grep", "read"]);
}, 60_000);

test("can run the allowed test commands (to reproduce), but cannot edit, run anything else, ask questions, or read secrets and outside paths", async () => {
  expect(await outcome("bash", { command: "git status", description: "t" })).toBe("allowed");
  for (const [tool, args] of [
    ["write", { filePath: join(repo.dir, "src/new.ts"), content: "x\n" }],
    ["edit", { filePath: join(repo.dir, "README.md"), oldString: "fixture", newString: "changed" }],
    ["bash", { command: "ls", description: "t" }],
    ["bash", { command: "touch made.txt", description: "t" }],
    ["question", { questions: [{ question: "a or b?", header: "Q", options: [{ label: "a", description: "a" }, { label: "b", description: "b" }] }] }],
    ["read", { filePath: join(repo.dir, ".env") }],
    ["read", { filePath: join(repo.dir, "config", ".env.local") }],
    ["read", { filePath: "/etc/hosts" }],
    ["webfetch", { url: "https://example.com", format: "text" }],
    ["task", { description: "x", prompt: "y", subagent_type: "general" }],
    ["skill", { name: "x" }],
    ["todowrite", { todos: [] }],
    ["finish", { summary: "x", risks: [], review: [], missing: [] }],
  ] as const) {
    const o = await outcome(tool, args);
    expect(blocked(o), `${tool} ${JSON.stringify(args)} → ${o}`).toBe(true);
  }
  // the tree is exactly as it was
  expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe(status);
  expect(existsSync(join(repo.dir, "made.txt"))).toBe(false);
}, 120_000);

test("secrets never reach the model through grep; .env.example stays readable", async () => {
  for (const args of [{ pattern: "SECRET" }, { pattern: "SECRET", include: ".env*" }]) {
    const grep = await call("grep", args);
    expect(grep.outcome).toBe("allowed");
    expect(grep.output).toContain(".env.example");
    expect(JSON.stringify(llm.requests.at(-1).messages)).not.toMatch(/SECRET=[12]/);
  }
  const example = await call("read", { filePath: join(repo.dir, ".env.example") });
  expect(example.outcome).toBe("allowed");
  expect(example.output).toContain("put-yours-here");
}, 60_000);
