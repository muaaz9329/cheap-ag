import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode } from "./fake-opencode.js";
import { allowRepo, callText, hermeticHome as makeHome, homeEnv, serverEntry, startServer, tempRepo, type Logins } from "./harness.js";

/** A hermetic home for running the CLI outside a server, removed after the test. */
function hermeticHome(logins?: Logins) {
  const h = makeHome(logins);
  onTestFinished(() => rmSync(h.home, { recursive: true, force: true }));
  return h;
}

const PLAN = (doneWhen = "hello exists") => `# Hello
## 1 hello
files: hello.txt
do: write hello.txt
done-when: ${doneWhen}
`;

/** Every OpenRouter default role and fallback model (src/routing.ts). */
const OPENROUTER_MODELS = ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash", "z-ai/glm-5.3-flash", "qwen/qwen3.7-plus", "z-ai/glm-5.3", "moonshotai/kimi-k3"];

const FINISH = { finish: { summary: "wrote hello", risks: [], review: [], missing: [] } };

/** A repo with a plan, a fake worker and a server; `allow` opts the repo in first through the real CLI. */
async function scenario(opts: { logins?: Logins; allow?: string[]; plan?: string } = {}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), opts.plan ?? PLAN());
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const logins = opts.logins ?? { "opencode-go": "k" };
  const start = async (allow?: string[]) => {
    const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins, allow });
    onTestFinished(server.close);
    return server;
  };
  const server = await start(opts.allow);
  const delegate = (client = server.client, extra: Record<string, unknown> = {}) => callText(client, "delegate", { plan: "plan.md", steps: "1", ...extra });
  return { repo, fake, server, start, delegate, logins };
}

/** Nothing was created and nothing reached OpenCode, let alone a provider. */
function expectUntouched(repo: { dir: string }, fake: { recorded: { requests: unknown[] } }) {
  expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees"))).toBe(false);
  expect(fake.recorded.requests).toEqual([]);
}

const opencodeConfig = (dir: string) => JSON.parse(readFileSync(join(dir, ".cheapag", "opencode", "opencode.json"), "utf8"));

test("first delegate in an unapproved repo returns CONSENT and creates no job; after the developer allows it, the job runs", async () => {
  const { repo, fake, server, delegate, logins } = await scenario();
  const text = await delegate();
  expect(text).toBe([
    `CONSENT repo=${repo.dir.split("/").at(-1)}`,
    "send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
    "retention: deepseek-v4.1-flash = zero retention; qwen3.8-flash = zero retention; deepseek-v4-pro = zero retention; qwen3.7-plus = zero retention; glm-5.3 = not stated; kimi-k3 = not stated",
    "approve: ask the user to run /cheapag:allow (all) or /cheapag:allow --zdr-only (terminal: npx cheap-agent allow [--zdr-only | --models a,b]); never approve yourself",
  ].join("\n"));
  expectUntouched(repo, fake);

  // the developer approves from a terminal while the server keeps running
  const { env } = hermeticHome(logins);
  expect(allowRepo(repo.dir, env)).toContain("code may go to OpenCode Go (all models)");
  expect(JSON.parse(readFileSync(join(repo.dir, ".cheapag", "consent.json"), "utf8"))).toMatchObject({ mode: "all", provider: "opencode-go" });
  fake.script({ edit: "hello.txt", content: "hi\n" }, { tool: "write" }, FINISH);
  expect(await delegate(server.client)).toMatch(/^OK j\w{4} step=1 /);
});

test("consent survives a server restart", async () => {
  const { fake, server, start, delegate } = await scenario({ allow: [] });
  await server.close();
  const again = await start();
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate(again.client)).toMatch(/^OK /);
});

test("the MCP tools offer no way to approve: no such tool or argument, and an extra argument is ignored", async () => {
  const { repo, fake, server, delegate } = await scenario();
  const { tools } = await server.client.listTools();
  for (const tool of tools) {
    expect(tool.name).not.toMatch(/allow|consent|approv/i);
    expect(Object.keys(tool.inputSchema.properties ?? {}).join(" ")).not.toMatch(/allow|consent|approv/i);
  }
  expect(await delegate(server.client, { consent: "all", allow: true })).toMatch(/^CONSENT /);
  expectUntouched(repo, fake);
});

test("zero-retention only blocks a model whose retention is not stated: FAIL no allowed model, nothing created", async () => {
  const { repo, fake, delegate } = await scenario({ logins: { deepseek: "k" }, allow: ["--zdr-only"] });
  expect(await delegate()).toBe(
    "FAIL reason: no allowed model for DeepSeek under this repo's consent (zero-retention only); ask the user to widen it with /cheapag:allow",
  );
  expectUntouched(repo, fake);
});

test("a consent given for one provider asks again after switching to another", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  allowRepo(repo.dir, hermeticHome({ "opencode-go": "k" }).env);
  writeFileSync(join(repo.dir, "plan.md"), PLAN());
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { openrouter: "k" } });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
  expect(text).toMatch(/^CONSENT /);
  expect(text).toContain("send: code from this repo → OpenRouter: deepseek/deepseek-v4.1-flash, qwen/qwen3.8-flash, z-ai/glm-5.3-flash (+fallbacks qwen/qwen3.7-plus, z-ai/glm-5.3, moonshotai/kimi-k3)\n");
  expect(text).toContain(`retention: depends on the upstream provider OpenRouter routes to; "deny data collection" is always on;`);
});

test("switching the worker preset after consent asks again; allowing the new route lets the job run", async () => {
  const { repo, fake, server, delegate } = await scenario({ allow: [] });
  // the developer re-runs login from a script on the server's own user config
  const env = homeEnv(server.home);
  execFileSync(process.execPath, [serverEntry, "login", "--preset", "strongest"], { env, stdio: "pipe" });
  const text = await delegate();
  expect(text).toMatch(/^CONSENT /);
  expect(text).toContain("send: code from this repo → OpenCode Go: glm-5.3, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, kimi-k3, deepseek-v4.1-flash)\n");
  expectUntouched(repo, fake);
  expect(allowRepo(repo.dir, env)).toContain("models: opencode-go/glm-5.3, opencode-go/qwen3.8-flash");
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "glm-5.3" });
});

test("OpenRouter zero-retention only adds its zdr routing preference to every model, on top of deny data collection", async () => {
  const { repo, fake, server, delegate } = await scenario({ logins: { openrouter: "k" }, allow: ["--zdr-only"] });
  // ping boots OpenCode on the default config first; the job must still get the zdr one
  expect(await callText(server.client, "ping")).toMatch(/^OK /);
  expect(opencodeConfig(repo.dir).provider.openrouter.models["deepseek/deepseek-v4.1-flash"].options.provider.zdr).toBeUndefined();
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  const zdr = { options: { provider: { data_collection: "deny", zdr: true } } };
  expect(opencodeConfig(repo.dir).provider).toEqual({ openrouter: { models: Object.fromEntries(OPENROUTER_MODELS.map((id) => [id, zdr])) } });
});

test("an explicit list without the escalation model: verify failures skip escalation instead of using it", async () => {
  const { fake, delegate } = await scenario({ allow: ["--models", "opencode-go/deepseek-v4.1-flash"], plan: PLAN("`test -f never-there`") });
  fake.script(FINISH);
  const text = await delegate();
  expect(text).toMatch(/^FAIL j\w{4} step=1 .* fix=2\n/);
  expect(text).toContain("\n  - esc: skipped, the escalation model is not allowed by this repo's consent\n");
  expect(fake.recorded.prompts.every((p) => p.model?.modelID !== "deepseek-v4-pro")).toBe(true);
});

test("an explicit list with only the escalation model runs the job on it, title generation included", async () => {
  const { repo, fake, delegate } = await scenario({ allow: ["--models", "opencode-go/deepseek-v4-pro"] });
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "deepseek-v4-pro" });
  expect(opencodeConfig(repo.dir).small_model).toBe("opencode-go/deepseek-v4-pro");
});

test("cheapag allow rejects unknown arguments and needs a login and a git repo", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { env, home } = hermeticHome({ "opencode-go": "k" });
  const fails = (cwd: string, e: Record<string, string>, args: string[]) => {
    try {
      allowRepo(cwd, e, args);
    } catch (err) {
      return (err as { stdout: Buffer }).stdout.toString();
    }
    throw new Error("allow succeeded");
  };
  expect(fails(repo.dir, env, ["--everything"])).toContain("usage: cheapag allow [--zdr-only | --models <provider/model,…>]");
  expect(fails(repo.dir, hermeticHome().env, [])).toContain("no worker provider; run npx cheap-agent login first");
  mkdirSync(join(home, "not-a-repo"));
  expect(fails(join(home, "not-a-repo"), env, [])).toContain("is not inside a git repository");
  expect(existsSync(join(repo.dir, ".cheapag", "consent.json"))).toBe(false);
});
