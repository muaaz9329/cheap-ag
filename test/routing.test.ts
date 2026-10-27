import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, startServer, tempRepo, type Logins } from "./harness.js";
import { loadConfig } from "../src/config.js";
import { parsePlan } from "../src/plan.js";
import { fullRoute, modelName, routeModels, tierModel, type Difficulty, type ModelsConfig } from "../src/routing.js";
import { instructions } from "../src/server.js";

/** Model routing through the MCP seam: provider limits, fallbacks, the allowlist, escalation skip, spend and billing. */

const PLAN = (doneWhen = "hello is written") => `# Hello\n\n## 1 hello\nfiles: hello.txt\ndo: write hello.txt\ndone-when: ${doneWhen}\n`;
const EDIT: Action = { edit: "hello.txt", content: "hi\n" };
const FINISH: Action = { finish: { summary: "wrote hello", risks: [], review: [], missing: [] } };
const GO_LIMIT = (next?: number): Action => ({
  retry: { reason: "account_rate_limit", message: "5h usage limit reached. It will reset in 2 hours 14 minutes. To continue using this model now, enable usage from your available balance", next },
});

async function scenario(opts: { scripts: Action[][]; logins?: Logins; allow?: string[]; doneWhen?: string; ledger?: { model: string; costUsd: number }[] }) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), PLAN(opts.doneWhen));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  for (const s of opts.scripts) fake.script(...s);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: opts.logins ?? { "opencode-go": "k" }, allow: opts.allow ?? [] });
  onTestFinished(server.close);
  // the user-wide spend ledger lives in the (hermetic) XDG state dir
  const ledger = join(server.home, "state", "cheapag", "spend.jsonl");
  if (opts.ledger) {
    mkdirSync(join(ledger, ".."), { recursive: true });
    writeFileSync(ledger, opts.ledger.map((e) => JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), ...e }) + "\n").join(""));
  }
  const delegate = () => callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
  const record = (text: string) => JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", text.match(/^\w+ (j[0-9a-z]{4}) /)![1], "result.json"), "utf8"));
  const models = () => fake.recorded.prompts.map((p) => p.model?.modelID);
  return { repo, fake, server, delegate, record, models, ledger };
}

test("a Go limit: aborted at once, the same session continues on the next fallback, model= in the headline; not a cap stop", async () => {
  const { repo, fake, delegate, record, models } = await scenario({ scripts: [[{ tool: "read" }, GO_LIMIT()], [EDIT, { tool: "write" }, FINISH]] });
  const started = Date.now();
  const text = await delegate();
  expect(Date.now() - started).toBeLessThan(10_000); // the hour-long retry is never waited out
  expect(text.split("\n")[0]).toMatch(/^OK j\w{4} step=1 files=1 \+1\/-0 tests=none turns=3 cost=\$0\.000 model=opencode-go\/qwen3\.7-plus$/);
  expect(readFileSync(join(repo.dir, "hello.txt"), "utf8")).toBe("hi\n");
  const session = fake.recorded.sessions[0].id;
  expect(fake.recorded.sessions).toHaveLength(1);
  expect(fake.recorded.aborts).toEqual([session]);
  expect(fake.recorded.prompts.map((p) => p.sessionID)).toEqual([session, session]);
  expect(fake.recorded.prompts[1].model).toEqual({ providerID: "opencode-go", modelID: "qwen3.7-plus" });
  expect(models()).toEqual([undefined, "qwen3.7-plus"]);
  expect(record(text).models).toEqual({ requested: "opencode-go/deepseek-v4.1-flash", final: "opencode-go/qwen3.7-plus", fallbacks: ["opencode-go/qwen3.7-plus"], escalated: false });
});

test("every allowed model capped → BUDGET with the Go window and the provider's reset time; the allowlist keeps GLM and Kimi out", async () => {
  const reset = Date.now() + 2 * 3_600_000;
  const { repo, delegate, models } = await scenario({ allow: ["--zdr-only"], scripts: [[EDIT, { tool: "write" }, GO_LIMIT(reset + 600_000)], [GO_LIMIT(reset)]] });
  const text = await delegate();
  const job = text.match(/^BUDGET (j\w{4}) /)![1];
  expect(text.split("\n")[0]).toBe(`BUDGET ${job} step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000 model=opencode-go/qwen3.7-plus`);
  // the earliest reset among the capped models
  expect(text).toContain(`\nreason: Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus (resets ~${new Date(reset).toTimeString().slice(0, 5)})\n`);
  expect(text).toContain(`\nworktree: .cheapag/worktrees/${job}/\n`);
  expect(models()).toEqual([undefined, "qwen3.7-plus"]); // glm-5.3 and kimi-k3 are not zero-retention: never tried
  expect(existsSync(join(repo.dir, "hello.txt"))).toBe(false);
});

test("an explicit allowlist: the fallback skips models it does not name", async () => {
  const { delegate, models } = await scenario({
    allow: ["--models", "opencode-go/deepseek-v4.1-flash,opencode-go/kimi-k3"],
    scripts: [[GO_LIMIT()], [EDIT, FINISH]],
  });
  expect(await delegate()).toMatch(/^OK j\w{4} .* model=opencode-go\/kimi-k3\n/);
  expect(models()).toEqual([undefined, "kimi-k3"]);
});

test("escalation is skipped near its tracked cap (tried: says why); escalation_skip_at in the config raises the bar", async () => {
  // V4 Pro's Go cap is $15/month, $3 per 5 h: $2.55 is 85%
  const { repo, fake, delegate, models } = await scenario({ doneWhen: "`test -f never-there`", scripts: [[FINISH]], ledger: [{ model: "opencode-go/deepseek-v4-pro", costUsd: 2.55 }] });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^FAIL j\w{4} step=1 .* fix=2$/);
  expect(text).toContain("\n  - esc: skipped, deepseek-v4-pro at 85% of its tracked 5h cap ($3.00)\n");
  expect(models()).not.toContain("deepseek-v4-pro");

  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ escalation_skip_at: 0.9 }));
  fake.script(FINISH);
  const again = await delegate();
  expect(again.split("\n")[0]).toMatch(/ fix=2 esc=1 model=opencode-go\/deepseek-v4-pro$/);
  expect(models().at(-1)).toBe("deepseek-v4-pro");
});

test("spend is recorded per model in the user-wide ledger; past a Go window's cap the job shows billing=zen", async () => {
  // Flash's 5h window is $16 (20% of $80): already past it, yet the model kept answering
  const { delegate, ledger } = await scenario({ scripts: [[EDIT, { usage: { cost: 0.02 } }, FINISH]], ledger: [{ model: "opencode-go/deepseek-v4.1-flash", costUsd: 16 }] });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^OK j\w{4} .* cost=\$0\.020 billing=zen$/);
  const last = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n").at(-1)!);
  expect(last).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash", costUsd: 0.02 });
});

test("a job well inside its windows shows no billing token", async () => {
  const { delegate } = await scenario({ scripts: [[EDIT, { usage: { cost: 0.02 } }, FINISH]] });
  expect((await delegate()).split("\n")[0]).toMatch(/cost=\$0\.020$/);
});

test("OpenRouter out of credits (402) → BUDGET, with no fallback since every model draws on the same credit", async () => {
  const { delegate, models } = await scenario({
    logins: { openrouter: "sk-or-v1-testkeytestkeytestkey" },
    scripts: [[{ error: { name: "APIError", message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", statusCode: 402 } }]],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^BUDGET j\w{4} step=1 /);
  expect(text).toContain("\nreason: OpenRouter credits exhausted\n");
  expect(models()).toEqual([undefined]);
});

test("an OpenRouter rate limit (429, no Go reason) takes the same abort-and-fallback path", async () => {
  const { fake, delegate, models } = await scenario({
    logins: { openrouter: "sk-or-v1-testkeytestkeytestkey" },
    scripts: [[{ retry: { message: "Rate limit exceeded: free-models-per-min" } }], [EDIT, FINISH]],
  });
  expect(await delegate()).toMatch(/^OK j\w{4} .* model=openrouter\/qwen\/qwen3\.7-plus\n/);
  expect(models()).toEqual([undefined, "qwen/qwen3.7-plus"]);
  expect(fake.recorded.aborts).toHaveLength(1);
});

test("an OpenRouter rate limit on every allowed model → BUDGET naming the provider and the retry time", async () => {
  const { delegate } = await scenario({
    logins: { openrouter: "sk-or-v1-testkeytestkeytestkey" },
    allow: ["--models", "openrouter/deepseek/deepseek-v4.1-flash"],
    scripts: [[{ retry: { message: "Rate limit exceeded" } }]],
  });
  expect(await delegate()).toMatch(/\nreason: OpenRouter rate limit on every allowed model: deepseek\/deepseek-v4\.1-flash \(retry ~[^)]*\d\d:\d\d\)\n/);
});

test("a transient retry on Go (no limit reason, a quick backoff) is not a limit: no abort, no fallback, same model", async () => {
  const { delegate, fake, models } = await scenario({
    scripts: [[{ tool: "read" }, { retry: { message: "Overloaded", next: Date.now() + 2_000, recoverAfter: 300 } }, EDIT, { tool: "write" }, FINISH]],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^OK j\w{4} step=1 .* cost=\$0\.000$/); // no model= token
  expect(fake.recorded.aborts).toEqual([]);
  expect(models()).toEqual([undefined]);
});

test("a BUDGET whose retry time is only OpenCode's short backoff quotes the provider's own text instead", async () => {
  const { delegate } = await scenario({
    logins: { openrouter: "sk-or-v1-testkeytestkeytestkey" },
    allow: ["--models", "openrouter/deepseek/deepseek-v4.1-flash"],
    scripts: [[{ retry: { message: "Rate limit exceeded: free-models-per-day. Resets tomorrow", next: Date.now() + 5_000 } }]],
  });
  expect(await delegate()).toMatch(/\nreason: OpenRouter rate limit on every allowed model: deepseek\/deepseek-v4\.1-flash \(retry Rate limit exceeded: free-models-per-day\. Resets tomorrow\)\n/);
});

test("config models override the role defaults; a model for another provider is ignored", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), PLAN());
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { implement: "opencode-go/glm-5.3", fallback: ["opencode-go/kimi-k3"], escalation: "openrouter/x/y" } }));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" } });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
  expect(text).toContain("send: code from this repo → OpenCode Go: glm-5.3, qwen3.8-flash, deepseek-v4-pro (+fallbacks kimi-k3, deepseek-v4.1-flash)\n");
});

test("config models: the job runs on the configured implement model; a malformed models entry is a FAIL before any job", async () => {
  const { repo, fake, delegate } = await scenario({ scripts: [[EDIT, FINISH]] });
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { implement: "opencode-go/glm-5.3" } }));
  expect(await delegate()).toMatch(/^OK /);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "glm-5.3" });

  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { fallback: "opencode-go/kimi-k3" } }));
  expect(await delegate()).toMatch(/^FAIL reason: .*cheapag\.json: models\.fallback must be a list of provider\/model names$/);
});

// ---- ticket 26: difficulty routing ----

test("tierModel: hard → models.hard ?? models.medium ?? implement; medium → models.medium ?? implement; easy or no hint → implement", () => {
  const ids = (models: ModelsConfig) => {
    const r = fullRoute("opencode-go", models);
    return [undefined, "easy", "medium", "hard"].map((d) => tierModel(r, d as Difficulty | undefined).id);
  };
  const flash = "deepseek-v4.1-flash";
  expect(ids({})).toEqual([flash, flash, flash, flash]); // no default tier model: the GLM-5.3 gain in 25 did not hold on the hard tier
  expect(ids({ medium: "opencode-go/glm-5.3" })).toEqual([flash, flash, "glm-5.3", "glm-5.3"]);
  expect(ids({ medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" })).toEqual([flash, flash, "glm-5.3", "kimi-k3"]);
  expect(ids({ hard: "openrouter/x/y" })).toEqual([flash, flash, flash, flash]); // another provider's: ignored
  // the tier models are models the route may send code to, so consent (the CONSENT block, cheapag allow) names them
  expect(routeModels(fullRoute("opencode-go", { hard: "opencode-go/minimax-m3" })).map(modelName)).toContain("opencode-go/minimax-m3");
});

test("plan steps accept difficulty:; any other value is a plan error", () => {
  const plan = (d: string) => `# P\n## 1 a\nfiles: a.txt\ndone-when: done\ndifficulty: ${d}\n`;
  expect(parsePlan(plan("hard")).steps[0].fields.difficulty).toBe("hard");
  expect(() => parsePlan(plan("tricky"))).toThrow("step 1 (line 2): difficulty: must be easy, medium, hard or left out");
});

test("config: models.medium and models.hard take provider/model names; hard_tasks is delegate, self or sonnet (default delegate)", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const load = (config: object) => {
    writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(config));
    return loadConfig(repo.dir);
  };
  expect(load({}).hard_tasks).toBe("delegate");
  expect(load({ models: { medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" }, hard_tasks: "sonnet" }))
    .toMatchObject({ models: { medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" }, hard_tasks: "sonnet" });
  expect(() => load({ models: { medium: "glm-5.3" } })).toThrow("models.medium must be a provider/model name");
  expect(() => load({ models: { hard: 3 } })).toThrow("models.hard must be a provider/model name");
  expect(() => load({ hard_tasks: "opus" })).toThrow("hard_tasks must be one of delegate, self, sonnet");
});

test("server instructions: one hint sentence, and hard_tasks adds its rule; every variant stays under the 4,096-character cut", () => {
  const hint = "Pass difficulty, rated from the issue as the time an engineer new to the code needs to fix and test it: easy < 15 min, medium < 1 h, hard > 1 h.";
  const [delegate, self, sonnet] = (["delegate", "self", "sonnet"] as const).map((h) => instructions(h));
  for (const text of [delegate, self, sonnet]) {
    expect(text).toContain(hint);
    expect(text.length).toBeLessThan(4096);
  }
  expect(delegate).toContain(`${hint}\n`);
  expect(self).toContain(`${hint} For a hard task, do it yourself instead of delegating.\n`);
  expect(sonnet).toContain(`${hint} For a hard task, use your Agent tool with model: sonnet to implement it instead of delegating.\n`);
});

test("a difficulty hint routes the job to its tier model: model= in the headline, the hint on the record; a step's own key wins", async () => {
  const { repo, fake, server, record } = await scenario({ scripts: [[EDIT, FINISH], [EDIT, FINISH], [EDIT, FINISH]] });
  const { tools } = await server.client.listTools();
  expect(tools.find((t) => t.name === "delegate")!.inputSchema.properties!.difficulty).toMatchObject({ type: "string", enum: ["easy", "medium", "hard"] });
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { medium: "opencode-go/glm-5.3" } }));
  const delegate = (args: Record<string, unknown>) => callText(server.client, "delegate", { plan: "plan.md", steps: "1", ...args });

  const medium = await delegate({ difficulty: "medium" });
  expect(medium.split("\n")[0]).toMatch(/^OK j\w{4} step=1 .* model=opencode-go\/glm-5\.3$/);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "glm-5.3" });
  expect(record(medium)).toMatchObject({ difficulty: "medium", models: { requested: "opencode-go/deepseek-v4.1-flash", final: "opencode-go/glm-5.3" } });

  const easy = await delegate({ difficulty: "easy" });
  expect(easy.split("\n")[0]).not.toContain("model=");
  expect(fake.recorded.sessions[1].model).toEqual({ providerID: "opencode-go", id: "deepseek-v4.1-flash" });

  // a plan step rated hard, no models.hard: the medium model, whatever the call said
  writeFileSync(join(repo.dir, "plan.md"), PLAN().replace("done-when:", "difficulty: hard\ndone-when:"));
  const hard = await delegate({ difficulty: "easy" });
  expect(hard.split("\n")[0]).toMatch(/ model=opencode-go\/glm-5\.3$/);
  expect(record(hard).difficulty).toBe("hard");
});

test("consent covers the tier models: the CONSENT block names them; one the allowlist leaves out runs its tier on the implement model", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), PLAN());
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ models: { hard: "opencode-go/kimi-k3" }, hard_tasks: "self" }));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const unapproved = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" } });
  onTestFinished(unapproved.close);
  // the repo's hard_tasks reaches the instructions, read at startup
  expect(unapproved.client.getInstructions()).toContain("For a hard task, do it yourself instead of delegating.");
  expect(await callText(unapproved.client, "delegate", { plan: "plan.md", steps: "1", difficulty: "hard" })).toContain("send: code from this repo → OpenCode Go: deepseek-v4.1-flash, kimi-k3, ");

  fake.script(EDIT, FINISH);
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: ["--models", "opencode-go/deepseek-v4.1-flash"] });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: "plan.md", steps: "1", difficulty: "hard" });
  expect(text.split("\n")[0]).toMatch(/^OK .* cost=\$0\.000$/);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "deepseek-v4.1-flash" });
});
