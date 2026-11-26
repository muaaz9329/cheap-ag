import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { allowRepo, callText, homeEnv, startServer, tempRepo, type Logins } from "./harness.js";
import { loadConfig } from "../src/config.js";
import { PROVIDERS, type Provider } from "../src/credentials.js";
import { parsePlan } from "../src/plan.js";
import {
  capUse,
  chain,
  clock,
  DIFFICULTIES,
  effectiveModels,
  escalationSkip,
  foreignModels,
  fullRoute,
  ledgerFile,
  localEndpoint,
  modelName,
  PRESET_NAMES,
  PRESETS,
  presetOf,
  recordSpend,
  ROLES,
  routeModels,
  runRouted,
  spendWindows,
  tierModel,
  usedBalance,
  type Difficulty,
  type Limit,
  type ModelsConfig,
  type WorkerModel,
} from "../src/routing.js";
import { instructions } from "../src/server.js";
import type { RunResult } from "../src/worker.js";

/** Model routing through the MCP seam: provider limits, fallbacks, the allowlist, escalation skip, spend and billing. */

const PLAN = (doneWhen = "hello is written") =>
  `# Hello\n\n## 1 hello\nfiles: hello.txt\ndo: write hello.txt\ndone-when: ${doneWhen}\n`;
const EDIT: Action = { edit: "hello.txt", content: "hi\n" };
const FINISH: Action = { finish: { summary: "wrote hello", risks: [], review: [], missing: [] } };
const GO_LIMIT = (next?: number): Action => ({
  retry: {
    reason: "account_rate_limit",
    message:
      "5h usage limit reached. It will reset in 2 hours 14 minutes. To continue using this model now, enable usage from your available balance",
    next,
  },
});

async function scenario(opts: {
  scripts: Action[][];
  logins?: Logins;
  allow?: string[];
  doneWhen?: string;
  ledger?: { model: string; costUsd: number }[];
  env?: Record<string, string>;
}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), PLAN(opts.doneWhen));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  for (const s of opts.scripts) fake.script(...s);
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url, ...opts.env },
    logins: opts.logins ?? { "opencode-go": "k" },
    allow: opts.allow ?? [],
  });
  onTestFinished(server.close);
  // the user-wide spend ledger lives in the (hermetic) XDG state dir
  const ledger = join(server.home, "state", "cheapag", "spend.jsonl");
  if (opts.ledger) {
    mkdirSync(join(ledger, ".."), { recursive: true });
    writeFileSync(
      ledger,
      opts.ledger
        .map(
          (e) => JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), ...e }) + "\n",
        )
        .join(""),
    );
  }
  const delegate = (model?: string) =>
    callText(server.client, "delegate", { plan: "plan.md", steps: "1", ...(model && { model }) });
  const record = (text: string) =>
    JSON.parse(
      readFileSync(
        join(repo.dir, ".cheapag", "jobs", text.match(/^\w+ (j[0-9a-z]{4}) /)![1], "result.json"),
        "utf8",
      ),
    );
  const models = () => fake.recorded.prompts.map((p) => p.model?.modelID);
  return { repo, fake, server, delegate, record, models, ledger };
}

test("a Go limit: aborted at once, the same session continues on the next fallback, model= in the headline; not a cap stop", async () => {
  const { repo, fake, delegate, record, models } = await scenario({
    scripts: [
      [{ tool: "read" }, GO_LIMIT()],
      [EDIT, { tool: "write" }, FINISH],
    ],
  });
  const started = Date.now();
  const text = await delegate();
  expect(Date.now() - started).toBeLessThan(10_000); // the hour-long retry is never waited out
  expect(text.split("\n")[0]).toMatch(
    /^OK j\w{4} step=1 files=1 \+1\/-0 tests=none turns=3 cost=\$0\.000 model=opencode-go\/qwen3\.7-plus$/,
  );
  expect(readFileSync(join(repo.dir, "hello.txt"), "utf8")).toBe("hi\n");
  const session = fake.recorded.sessions[0].id;
  expect(fake.recorded.sessions).toHaveLength(1);
  expect(fake.recorded.aborts).toEqual([session]);
  expect(fake.recorded.prompts.map((p) => p.sessionID)).toEqual([session, session]);
  expect(fake.recorded.prompts[1].model).toEqual({
    providerID: "opencode-go",
    modelID: "qwen3.7-plus",
  });
  expect(models()).toEqual([undefined, "qwen3.7-plus"]);
  expect(record(text).models).toEqual({
    requested: "opencode-go/deepseek-v4.1-flash",
    final: "opencode-go/qwen3.7-plus",
    fallbacks: ["opencode-go/qwen3.7-plus"],
    escalated: false,
  });
});

test("every allowed model capped → BUDGET with the Go window and the provider's reset time; the allowlist keeps GLM and Kimi out", async () => {
  const reset = Date.now() + 2 * 3_600_000;
  const { repo, delegate, models } = await scenario({
    allow: ["--zdr-only"],
    scripts: [[EDIT, { tool: "write" }, GO_LIMIT(reset + 600_000)], [GO_LIMIT(reset)]],
  });
  const text = await delegate();
  const job = text.match(/^BUDGET (j\w{4}) /)![1];
  expect(text.split("\n")[0]).toBe(
    `BUDGET ${job} step=1 files=1 +1/-0 tests=none turns=1 cost=$0.000 model=opencode-go/qwen3.7-plus`,
  );
  // the earliest reset among the capped models
  expect(text).toContain(
    `\nreason: Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus (resets ~${clock(reset)})\n`,
  );
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
  const { repo, fake, delegate, models } = await scenario({
    doneWhen: "`test -f never-there`",
    scripts: [[FINISH]],
    ledger: [{ model: "opencode-go/deepseek-v4-pro", costUsd: 2.55 }],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^FAIL j\w{4} step=1 .* fix=2$/);
  expect(text).toContain(
    "\n  - esc: skipped, deepseek-v4-pro at 85% of its tracked 5h cap ($3.00)\n",
  );
  expect(models()).not.toContain("deepseek-v4-pro");

  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ escalation_skip_at: 0.9 }));
  fake.script(FINISH);
  const again = await delegate();
  expect(again.split("\n")[0]).toMatch(/ fix=2 esc=1 model=opencode-go\/deepseek-v4-pro$/);
  expect(models().at(-1)).toBe("deepseek-v4-pro");
});

test("spend is recorded per model in the user-wide ledger; past a Go window's cap the job shows billing=zen", async () => {
  // Flash's 5h window is $16 (20% of $80): already past it, yet the model kept answering
  const { delegate, ledger } = await scenario({
    scripts: [[EDIT, { usage: { cost: 0.02 } }, FINISH]],
    ledger: [{ model: "opencode-go/deepseek-v4.1-flash", costUsd: 16 }],
  });
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
    scripts: [
      [
        {
          error: {
            name: "APIError",
            message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
            statusCode: 402,
          },
        },
      ],
    ],
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
  expect(await delegate()).toMatch(
    /\nreason: OpenRouter rate limit on every allowed model: deepseek\/deepseek-v4\.1-flash \(retry ~[^)]*\d\d:\d\d\)\n/,
  );
});

test("a transient retry on Go (no limit reason, a quick backoff) is not a limit: no abort, no fallback, same model", async () => {
  const { delegate, fake, models } = await scenario({
    scripts: [
      [
        { tool: "read" },
        { retry: { message: "Overloaded", next: Date.now() + 2_000, recoverAfter: 300 } },
        EDIT,
        { tool: "write" },
        FINISH,
      ],
    ],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^OK j\w{4} step=1 .* cost=\$0\.000$/); // no model= token
  expect(fake.recorded.aborts).toEqual([]);
  expect(models()).toEqual([undefined]);
});

const OVERLOADED: Action = {
  error: {
    name: "APIError",
    message: "Upstream request failed: [overloaded] the server is overloaded; retry shortly",
  },
};

test("a capacity error is retried once in a forked session on the same model, then lands OK", async () => {
  const { delegate, fake } = await scenario({ scripts: [[OVERLOADED], [EDIT, FINISH]] });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^OK j\w{4} step=1 .* cost=\$0\.000$/); // no model= token: still the same model
  expect(fake.recorded.forks).toHaveLength(1);
  const [first, second] = fake.recorded.prompts;
  expect(second.sessionID).toBe(fake.recorded.forks[0].to);
  expect(second.sessionID).not.toBe(first.sessionID);
  expect(JSON.stringify(second.parts)).toContain(
    "The previous attempt hit a provider capacity error",
  );
  expect(second.model).toEqual(first.model);
});

test("a capacity error that repeats after the fork ends PROVIDER: the model and the others named, no fallback; nothing lands", async () => {
  const { repo, delegate, fake, record } = await scenario({
    allow: ["--models", "opencode-go/deepseek-v4.1-flash,opencode-go/qwen3.7-plus"],
    scripts: [[OVERLOADED], [OVERLOADED], [OVERLOADED]],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^PROVIDER j\w{4} step=1 /);
  expect(record(text).status).toBe("PROVIDER");
  expect(text).toContain("deepseek-v4.1-flash is failing (last error: ");
  expect(text).toContain("other models: qwen3.7-plus");
  expect(text).toContain("next: ask the user: continue with Claude");
  expect(fake.recorded.prompts).toHaveLength(2);
  expect(fake.recorded.forks).toHaveLength(1);
  expect(existsSync(join(repo.dir, "hello.txt"))).toBe(false);
});

test("delegate model: runs the job on that allowed model (bare or full id); an unknown one is refused naming the allowed ids", async () => {
  const { delegate, fake } = await scenario({ scripts: [[EDIT, FINISH]] });
  expect(await delegate("qwen3.7-plus")).toMatch(/^OK .* model=opencode-go\/qwen3\.7-plus/);
  expect(fake.recorded.sessions.map((s) => s.model?.id)).toEqual(["qwen3.7-plus"]); // the session itself starts on it
  const refused = await delegate("gpt-9");
  expect(refused).toMatch(
    /^FAIL reason: model gpt-9 is not allowed here; allowed: deepseek-v4\.1-flash, .*; run \/cheapag:allow to add it/,
  );
  expect(fake.recorded.sessions).toHaveLength(1);
});

test("a 401 error ends FAIL after one prompt: no fork, no fallback", async () => {
  const { delegate, fake } = await scenario({
    scripts: [[{ error: { name: "APIError", message: "invalid api key", statusCode: 401 } }]],
  });
  const text = await delegate();
  expect(text.split("\n")[0]).toMatch(/^FAIL j\w{4} step=1 /);
  expect(text).toContain("reason: worker error: invalid api key");
  expect(fake.recorded.prompts).toHaveLength(1);
  expect(fake.recorded.forks).toEqual([]);
});

test("a BUDGET whose retry time is only OpenCode's short backoff quotes the provider's own text instead", async () => {
  const { delegate } = await scenario({
    logins: { openrouter: "sk-or-v1-testkeytestkeytestkey" },
    allow: ["--models", "openrouter/deepseek/deepseek-v4.1-flash"],
    scripts: [
      [
        {
          retry: {
            message: "Rate limit exceeded: free-models-per-day. Resets tomorrow",
            next: Date.now() + 5_000,
          },
        },
      ],
    ],
  });
  expect(await delegate()).toMatch(
    /\nreason: OpenRouter rate limit on every allowed model: deepseek\/deepseek-v4\.1-flash \(retry Rate limit exceeded: free-models-per-day\. Resets tomorrow\)\n/,
  );
});

test("config models override the role defaults; a model for another provider is ignored", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), PLAN());
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({
      models: {
        implement: "opencode-go/glm-5.3",
        fallback: ["opencode-go/kimi-k3"],
        escalation: "openrouter/x/y",
      },
    }),
  );
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
  });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
  expect(text).toContain(
    "send: code from this repo → OpenCode Go: glm-5.3, qwen3.8-flash, deepseek-v4-pro (+fallbacks kimi-k3, deepseek-v4.1-flash)\n",
  );
});

test("config models: the job runs on the configured implement model; a malformed models entry is a FAIL before any job", async () => {
  const { repo, fake, delegate } = await scenario({ scripts: [[EDIT, FINISH]] });
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: { implement: "opencode-go/glm-5.3" } }),
  );
  expect(await delegate()).toMatch(/^OK /); // same provider: another model never asks for consent again
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "glm-5.3" });

  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: { fallback: "opencode-go/kimi-k3" } }),
  );
  expect(await delegate()).toMatch(
    /^FAIL reason: .*cheapag\.json: models\.fallback must be a list of provider\/model names$/,
  );
});

// ---- ticket 26: difficulty routing ----

test("tierModel: hard → models.hard ?? models.medium ?? implement; medium → models.medium ?? implement; easy or no hint → implement", () => {
  const ids = (models: ModelsConfig) => {
    const r = fullRoute("opencode-go", models);
    return [undefined, "easy", "medium", "hard"].map(
      (d) => tierModel(r, d as Difficulty | undefined).id,
    );
  };
  const flash = "deepseek-v4.1-flash";
  expect(ids({})).toEqual([flash, flash, flash, flash]); // no default tier model: the GLM-5.3 gain in 25 did not hold on the hard tier
  expect(ids({ medium: "opencode-go/glm-5.3" })).toEqual([flash, flash, "glm-5.3", "glm-5.3"]);
  expect(ids({ medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" })).toEqual([
    flash,
    flash,
    "glm-5.3",
    "kimi-k3",
  ]);
  expect(ids({ hard: "openrouter/x/y" })).toEqual([flash, flash, flash, flash]); // another provider's: ignored
  // the tier models are models the route may send code to, so consent (the CONSENT block, cheapag allow) names them
  expect(
    routeModels(fullRoute("opencode-go", { hard: "opencode-go/minimax-m3" })).map(modelName),
  ).toContain("opencode-go/minimax-m3");
});

test("models.variants: a full model name's effort becomes the WorkerModel's variant; a model without an entry has none", () => {
  const route = fullRoute("opencode-go", {
    implement: "opencode-go/glm-5.3",
    variants: { "opencode-go/glm-5.3": "high" },
  });
  expect(route.implement.variant).toBe("high");
  expect(route.fallbacks.find((m) => m.id === "qwen3.7-plus")!.variant).toBeUndefined();
  expect(route.research!.variant).toBeUndefined();
  expect(
    fullRoute("opencode-go", { implement: "opencode-go/glm-5.3" }).implement.variant,
  ).toBeUndefined();
});

test("plan steps accept difficulty:; any other value is a plan error", () => {
  const plan = (d: string) => `# P\n## 1 a\nfiles: a.txt\ndone-when: done\ndifficulty: ${d}\n`;
  expect(parsePlan(plan("hard")).steps[0].fields.difficulty).toBe("hard");
  expect(() => parsePlan(plan("tricky"))).toThrow(
    "step 1 (line 2): difficulty: must be easy, medium, hard or left out",
  );
});

test("config: models.medium and models.hard take provider/model names; hard_tasks is delegate, self or sonnet (default delegate)", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const load = (config: object) => {
    writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(config));
    return loadConfig(repo.dir);
  };
  expect(load({}).hard_tasks).toBe("delegate");
  expect(
    load({
      models: { medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" },
      hard_tasks: "sonnet",
    }),
  ).toMatchObject({
    models: { medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" },
    hard_tasks: "sonnet",
  });
  expect(() => load({ models: { medium: "glm-5.3" } })).toThrow(
    "models.medium must be a provider/model name",
  );
  expect(() => load({ models: { hard: 3 } })).toThrow("models.hard must be a provider/model name");
  expect(() => load({ hard_tasks: "opus" })).toThrow(
    "hard_tasks must be one of delegate, self, sonnet",
  );
});

test("server instructions: one hint sentence, and hard_tasks adds its rule; every variant stays under the 4,096-character cut", () => {
  const hint =
    "Pass difficulty from the issue: time a new engineer needs to fix and test it, easy < 15 min, medium < 1 h, hard > 1 h.";
  const [delegate, self, sonnet] = (["delegate", "self", "sonnet"] as const).map((h) =>
    instructions(h),
  );
  for (const text of [delegate, self, sonnet]) {
    expect(text).toContain(hint);
    expect(text.length).toBeLessThan(4096);
  }
  expect(delegate).toContain(`${hint}\n`);
  expect(self).toContain(`${hint} For a hard task, do it yourself instead of delegating.\n`);
  expect(sonnet).toContain(
    `${hint} For a hard task, use your Agent tool with model: sonnet to implement it instead of delegating.\n`,
  );
});

test("a difficulty hint routes the job to its tier model: model= in the headline, the hint on the record; a step's own key wins", async () => {
  const { repo, fake, server, record } = await scenario({
    scripts: [
      [EDIT, FINISH],
      [EDIT, FINISH],
      [EDIT, FINISH],
    ],
  });
  const { tools } = await server.client.listTools();
  expect(
    tools.find((t) => t.name === "delegate")!.inputSchema.properties!.difficulty,
  ).toMatchObject({ type: "string", enum: ["easy", "medium", "hard"] });
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: { medium: "opencode-go/glm-5.3" } }),
  );
  allowRepo(repo.dir, homeEnv(server.home)); // a tier model changes the route, so consent is given again (ticket 27)
  const delegate = (args: Record<string, unknown>) =>
    callText(server.client, "delegate", { plan: "plan.md", steps: "1", ...args });

  const medium = await delegate({ difficulty: "medium" });
  expect(medium.split("\n")[0]).toMatch(/^OK j\w{4} step=1 .* model=opencode-go\/glm-5\.3$/);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "glm-5.3" });
  expect(record(medium)).toMatchObject({
    difficulty: "medium",
    models: { requested: "opencode-go/deepseek-v4.1-flash", final: "opencode-go/glm-5.3" },
  });

  const easy = await delegate({ difficulty: "easy" });
  expect(easy.split("\n")[0]).not.toContain("model=");
  expect(fake.recorded.sessions[1].model).toEqual({
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
  });

  // a plan step rated hard, no models.hard: the medium model, whatever the call said
  writeFileSync(
    join(repo.dir, "plan.md"),
    PLAN().replace("done-when:", "difficulty: hard\ndone-when:"),
  );
  const hard = await delegate({ difficulty: "easy" });
  expect(hard.split("\n")[0]).toMatch(/ model=opencode-go\/glm-5\.3$/);
  expect(record(hard).difficulty).toBe("hard");
});

test("consent covers the tier models: the CONSENT block names them; one the allowlist leaves out runs its tier on the implement model", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(join(repo.dir, "plan.md"), PLAN());
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({ models: { hard: "opencode-go/kimi-k3" }, hard_tasks: "self" }),
  );
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const unapproved = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
  });
  onTestFinished(unapproved.close);
  // the repo's hard_tasks reaches the instructions, read at startup
  expect(unapproved.client.getInstructions()).toContain(
    "For a hard task, do it yourself instead of delegating.",
  );
  expect(
    await callText(unapproved.client, "delegate", {
      plan: "plan.md",
      steps: "1",
      difficulty: "hard",
    }),
  ).toContain("send: code from this repo → OpenCode Go: deepseek-v4.1-flash, kimi-k3, ");

  fake.script(EDIT, FINISH);
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
    allow: ["--models", "opencode-go/deepseek-v4.1-flash"],
  });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", {
    plan: "plan.md",
    steps: "1",
    difficulty: "hard",
  });
  expect(text.split("\n")[0]).toMatch(/^OK .* cost=\$0\.000$/);
  expect(fake.recorded.sessions[0].model).toEqual({
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
  });
});

// ---- commandcode presets and role defaults ----

test("commandcode presets: cheapest and balanced implement on Flash, strongest on V4 Pro; roles default Flash with V4 Pro escalation", () => {
  const implement = (models: ModelsConfig) => modelName(fullRoute("commandcode", models).implement);
  expect(implement(PRESETS.commandcode.cheapest)).toBe("commandcode/deepseek/deepseek-v4.1-flash");
  expect(implement(PRESETS.commandcode.balanced)).toBe("commandcode/deepseek/deepseek-v4.1-flash");
  expect(implement(PRESETS.commandcode.strongest)).toBe("commandcode/deepseek/deepseek-v4-pro");

  const route = fullRoute("commandcode");
  expect(modelName(route.implement)).toBe("commandcode/deepseek/deepseek-v4.1-flash");
  expect(modelName(route.research!)).toBe("commandcode/deepseek/deepseek-v4.1-flash");
  expect(modelName(route.escalation!)).toBe("commandcode/deepseek/deepseek-v4-pro");
});

// ---- opencode (Zen) presets and role defaults ----

test("Ollama is listed 4th, after DeepSeek; the hosted providers keep their relative order, and the custom endpoint stays last", () => {
  expect(PROVIDERS.map((p) => p.id)).toEqual([
    "opencode-go",
    "openrouter",
    "deepseek",
    "ollama",
    "commandcode",
    "opencode",
    "local",
  ]);
});

test("opencode (Zen) presets: cheapest and balanced implement on Flash, strongest on GLM; roles default Flash with V4 Pro escalation and no Go-only fallback", () => {
  const implement = (models: ModelsConfig) => modelName(fullRoute("opencode", models).implement);
  expect(implement(PRESETS.opencode.cheapest)).toBe("opencode/deepseek-v4.1-flash");
  expect(implement(PRESETS.opencode.balanced)).toBe("opencode/deepseek-v4.1-flash");
  expect(implement(PRESETS.opencode.strongest)).toBe("opencode/glm-5.3");
  expect(presetOf("opencode", PRESETS.opencode.strongest)).toBe("strongest");
  expect(presetOf("opencode", { implement: "opencode/kimi-k3" })).toBe("custom");

  const route = fullRoute("opencode");
  expect(modelName(route.escalation!)).toBe("opencode/deepseek-v4-pro");
  expect(modelName(route.research!)).toBe("opencode/qwen3.8-flash");
  expect(routeModels(route).map(modelName)).not.toContain("opencode/qwen3.7-plus");
  expect(routeModels(route).every((m) => m.providerID === "opencode")).toBe(true);
  expect(modelName(fullRoute("opencode", { implement: "opencode-go/glm-5.3" }).implement)).toBe(
    "opencode/deepseek-v4.1-flash",
  );
});

test("effectiveModels: the preset's models, with an explicit models role winning", () => {
  expect(effectiveModels("opencode-go", { preset: "strongest", models: {} })).toEqual(
    PRESETS["opencode-go"].strongest,
  );
  expect(effectiveModels("opencode-go", { models: { medium: "opencode-go/glm-5.3" } })).toEqual({
    medium: "opencode-go/glm-5.3",
  });
  expect(
    effectiveModels("opencode-go", {
      preset: "strongest",
      models: { implement: "opencode-go/kimi-k3" },
    }),
  ).toEqual({ implement: "opencode-go/kimi-k3", medium: PRESETS["opencode-go"].strongest.medium });
});

test("a damaged ollama entry does not count as a local endpoint: the preset still applies (the config load reports the damage)", () => {
  const config = mkdtempSync(join(tmpdir(), "cheapag-routing-"));
  vi.stubEnv("XDG_CONFIG_HOME", config);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(config, { recursive: true, force: true });
  });
  mkdirSync(join(config, "cheapag"));
  writeFileSync(
    join(config, "cheapag", "config.json"),
    JSON.stringify({ ollama: { endpoint: "bogus" } }),
  );
  expect(effectiveModels("ollama", { preset: "cheapest", models: {} })).toEqual(
    effectiveModels("opencode-go", { models: PRESETS.ollama.cheapest }),
  );
  // a valid local endpoint has no presets: only the configured models count
  writeFileSync(
    join(config, "cheapag", "config.json"),
    JSON.stringify({ ollama: { endpoint: "local", model: "llama3.2" } }),
  );
  expect(
    effectiveModels("ollama", { preset: "cheapest", models: { implement: "ollama/x" } }),
  ).toEqual({ implement: "ollama/x" });
});

// ---- the module's own behavior, called directly ----

test("the role defaults, presets, preset names and difficulties: every entry and its order", () => {
  expect(JSON.stringify(ROLES)).toBe(
    JSON.stringify({
      ollama: {
        implement: ["deepseek-v4.1-flash:cloud", "glm-5.3-flash:cloud", "qwen3.7-plus:cloud"],
        research: ["qwen3.8-flash:cloud", "deepseek-v4.1-flash:cloud"],
        escalation: "glm-5.3:cloud",
      },
      "opencode-go": {
        implement: ["deepseek-v4.1-flash", "qwen3.7-plus", "glm-5.3", "kimi-k3"],
        research: ["qwen3.8-flash", "deepseek-v4.1-flash"],
        escalation: "deepseek-v4-pro",
      },
      openrouter: {
        implement: [
          "deepseek/deepseek-v4.1-flash",
          "qwen/qwen3.7-plus",
          "z-ai/glm-5.3",
          "moonshotai/kimi-k3",
        ],
        research: ["qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash"],
        escalation: "z-ai/glm-5.3-flash",
      },
      opencode: {
        implement: ["deepseek-v4.1-flash", "glm-5.3", "kimi-k3"],
        research: ["qwen3.8-flash", "deepseek-v4.1-flash"],
        escalation: "deepseek-v4-pro",
      },
      deepseek: {
        implement: ["deepseek-flash"],
        research: ["deepseek-flash"],
        escalation: "deepseek-v4-pro",
      },
      commandcode: {
        implement: ["deepseek/deepseek-v4.1-flash"],
        research: ["deepseek/deepseek-v4.1-flash"],
        escalation: "deepseek/deepseek-v4-pro",
      },
    }),
  );
  expect(JSON.stringify(PRESETS)).toBe(
    JSON.stringify({
      ollama: {
        cheapest: { implement: "ollama/deepseek-v4.1-flash:cloud" },
        balanced: { implement: "ollama/deepseek-v4.1-flash:cloud" },
        strongest: { implement: "ollama/glm-5.3:cloud" },
      },
      "opencode-go": {
        cheapest: { implement: "opencode-go/deepseek-v4.1-flash" },
        balanced: { implement: "opencode-go/deepseek-v4.1-flash" },
        strongest: { implement: "opencode-go/glm-5.3", medium: "opencode-go/glm-5.3" },
      },
      opencode: {
        cheapest: { implement: "opencode/deepseek-v4.1-flash" },
        balanced: { implement: "opencode/deepseek-v4.1-flash" },
        strongest: { implement: "opencode/glm-5.3", medium: "opencode/glm-5.3" },
      },
      openrouter: {
        cheapest: { implement: "openrouter/deepseek/deepseek-v4.1-flash" },
        balanced: { implement: "openrouter/deepseek/deepseek-v4.1-flash" },
        strongest: { implement: "openrouter/z-ai/glm-5.3", medium: "openrouter/z-ai/glm-5.3" },
      },
      deepseek: {
        cheapest: { implement: "deepseek/deepseek-flash" },
        balanced: { implement: "deepseek/deepseek-flash" },
        strongest: { implement: "deepseek/deepseek-v4-pro" },
      },
      commandcode: {
        cheapest: { implement: "commandcode/deepseek/deepseek-v4.1-flash" },
        balanced: { implement: "commandcode/deepseek/deepseek-v4.1-flash" },
        strongest: { implement: "commandcode/deepseek/deepseek-v4-pro" },
      },
    }),
  );
  expect(PRESET_NAMES).toEqual(["cheapest", "balanced", "strongest"]);
  expect(DIFFICULTIES).toEqual(["easy", "medium", "hard"]);
});

test("a local or Ollama route with nothing configured throws the login hint; only the custom endpoint is local then", () => {
  const config = mkdtempSync(join(tmpdir(), "cheapag-routing-"));
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.stubEnv("OLLAMA_API_KEY", "");
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(config, { recursive: true, force: true });
  });
  expect(() => fullRoute("local")).toThrow(
    new Error("no local server configured; run npx cheap-agent login"),
  );
  expect(() => fullRoute("ollama")).toThrow(
    new Error("no Ollama endpoint configured; run npx cheap-agent login"),
  );
  expect(localEndpoint("local")).toBe(true);
  expect(localEndpoint("ollama")).toBe(false);
  expect(localEndpoint("opencode-go")).toBe(false);
});

test("fullRoute: the default Go route, and an OpenRouter route with every role, fallback and variant set", () => {
  const go = (id: string): WorkerModel => ({ providerID: "opencode-go", id });
  expect(fullRoute("opencode-go")).toStrictEqual({
    implement: go("deepseek-v4.1-flash"),
    medium: undefined,
    hard: undefined,
    fallbacks: [go("qwen3.7-plus"), go("glm-5.3"), go("kimi-k3")],
    escalation: go("deepseek-v4-pro"),
    research: go("qwen3.8-flash"),
    researchFallbacks: [go("deepseek-v4.1-flash")],
  });

  const options = { provider: { data_collection: "deny", sort: "throughput" } };
  const routed = (id: string): WorkerModel => ({ providerID: "openrouter", id, options });
  const tuned = fullRoute("openrouter", {
    implement: "openrouter/z-ai/glm-5.3",
    medium: "openrouter/a/medium",
    hard: "deepseek/deepseek-v4-pro",
    research: "openrouter/r/research",
    escalation: "openrouter/e/escalation",
    fallback: ["openrouter/f/one", "opencode-go/kimi-k3", "openrouter/f/two"],
    variants: { "openrouter/f/two": "high", "openrouter/r/research": "low" },
  });
  expect(tuned).toStrictEqual({
    implement: routed("z-ai/glm-5.3"),
    medium: routed("a/medium"),
    hard: undefined,
    fallbacks: [routed("f/one"), { ...routed("f/two"), variant: "high" }],
    escalation: routed("e/escalation"),
    research: { ...routed("r/research"), variant: "low" },
    researchFallbacks: [routed("deepseek/deepseek-v4.1-flash")],
  });
  // every OpenRouter model shares the one data-collection preference object
  expect(tuned.implement.options).toBe(tuned.fallbacks[0].options);

  // an empty fallback list means no fallbacks, not the defaults
  expect(fullRoute("opencode-go", { fallback: [] }).fallbacks).toEqual([]);
  expect(fullRoute("opencode-go", { fallback: ["openrouter/a/b"] }).fallbacks).toEqual([]);

  // a name that is only the prefix: implement and research keep the empty id, a tier, escalation or fallback drops it
  const empty = fullRoute("opencode-go", {
    implement: "opencode-go/",
    research: "opencode-go/",
    medium: "opencode-go/",
    escalation: "opencode-go/",
    fallback: ["opencode-go/"],
  });
  expect(empty.implement).toEqual(go(""));
  expect(empty.research).toEqual(go(""));
  expect(empty.medium).toBeUndefined();
  expect(empty.escalation).toEqual(go("deepseek-v4-pro"));
  expect(empty.fallbacks).toEqual([]);
});

test("routeModels: implement, tiers, research, escalation, then fallbacks; a model seen before is left out", () => {
  const route = fullRoute("opencode-go");
  const models = routeModels(route);
  expect(models.map(modelName)).toEqual([
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/qwen3.8-flash",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/qwen3.7-plus",
    "opencode-go/glm-5.3",
    "opencode-go/kimi-k3",
  ]);
  expect(models[0]).toBe(route.implement);
  expect(
    routeModels(fullRoute("opencode-go", { hard: "opencode-go/glm-5.3" })).map(modelName),
  ).toEqual([
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/glm-5.3",
    "opencode-go/qwen3.8-flash",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/qwen3.7-plus",
    "opencode-go/kimi-k3",
  ]);
});

test("foreignModels: roles in order, then each foreign fallback; the provider prefix includes its slash", () => {
  expect(foreignModels("opencode-go")).toEqual([]);
  expect(
    foreignModels("opencode-go", {
      fallback: ["openrouter/a/b", "opencode-go/kimi-k3", "opencode/glm-5.3"],
      escalation: "deepseek/deepseek-v4-pro",
      research: "opencode-go/qwen3.8-flash",
      hard: "opencode-gox/x",
      medium: "",
      implement: "openrouter/z-ai/glm-5.3",
    }),
  ).toEqual([
    { role: "implement", name: "openrouter/z-ai/glm-5.3" },
    { role: "hard", name: "opencode-gox/x" },
    { role: "escalation", name: "deepseek/deepseek-v4-pro" },
    { role: "fallback", name: "openrouter/a/b" },
    { role: "fallback", name: "opencode/glm-5.3" },
  ]);
});

test("presetOf: no models is the default route, balanced; a tie with cheapest names balanced", () => {
  expect(presetOf("opencode-go")).toBe("balanced");
  expect(presetOf("opencode-go", PRESETS["opencode-go"].cheapest)).toBe("balanced");
  expect(presetOf("deepseek", { implement: "deepseek/deepseek-v4-pro" })).toBe("strongest");
  expect(presetOf("local")).toBe("custom");
});

test("chain: starts on the first model with a copy of the fallbacks, nothing hit or used", () => {
  const first: WorkerModel = { providerID: "opencode-go", id: "a" };
  const fallbacks: WorkerModel[] = [{ providerID: "opencode-go", id: "b" }];
  const c = chain(first, fallbacks);
  expect(c).toStrictEqual({ first, current: first, rest: fallbacks, limits: [], used: [] });
  expect(c.current).toBe(first);
  expect(c.rest).not.toBe(fallbacks);
});

/** A fake worker session: hands out `results` in order and records each prompt, its model and its signal. */
function fakeSession(results: RunResult[], rotates = true) {
  const runs: { text: string; model?: WorkerModel; interrupt?: AbortSignal }[] = [];
  const rotations: boolean[] = [];
  const session = {
    run: (text: string, model?: WorkerModel, interrupt?: AbortSignal) => {
      runs.push({ text, model, interrupt });
      return Promise.resolve(results.shift()!);
    },
    rotate: () => {
      rotations.push(rotates);
      return Promise.resolve(rotates);
    },
  };
  return { session, runs, rotations };
}

const FLASH: WorkerModel = { providerID: "opencode-go", id: "deepseek-v4.1-flash" };
const QWEN: WorkerModel = { providerID: "opencode-go", id: "qwen3.7-plus" };
const PRO: WorkerModel = { providerID: "opencode-go", id: "deepseek-v4-pro" };
const RETRY_TEXT =
  "The previous attempt hit a provider capacity error. Continue the current step from where it left off.";
const CONTINUE_TEXT =
  "The previous model hit a usage limit and was stopped. Continue the current step from where it left off.";

test("runRouted: a limit moves the same session to the next fallback, which every later prompt names", async () => {
  const limit: Limit = {
    model: "opencode-go/deepseek-v4.1-flash",
    reason: "account_rate_limit",
    message: "5h usage limit reached.",
    next: Date.now() + 3_600_000,
  };
  const { session, runs, rotations } = fakeSession([{ text: "", limit }, { text: "done" }]);
  const interrupt = new AbortController().signal;
  const c = chain(FLASH, [QWEN]);
  expect(await runRouted(session, "do it", c, "opencode-go", undefined, interrupt)).toStrictEqual({
    text: "done",
  });
  expect(runs).toStrictEqual([
    { text: "do it", model: undefined, interrupt },
    { text: CONTINUE_TEXT, model: QWEN, interrupt },
  ]);
  expect(rotations).toEqual([]);
  expect(c).toStrictEqual({
    first: FLASH,
    current: QWEN,
    rest: [],
    limits: [limit],
    used: ["opencode-go/qwen3.7-plus"],
  });
});

test("runRouted: a transient error is retried once after a fork, then ends PROVIDER naming the other models", async () => {
  const failing = fakeSession([
    { text: "", httpStatus: 503 },
    { text: "", httpStatus: 503 },
  ]);
  expect(
    await runRouted(failing.session, "do it", chain(FLASH, [QWEN, PRO]), "opencode-go"),
  ).toStrictEqual({
    text: "",
    httpStatus: 503,
    provider:
      "deepseek-v4.1-flash is failing (last error: HTTP 503); other models: qwen3.7-plus, deepseek-v4-pro",
  });
  expect(failing.runs.map((r) => r.text)).toEqual(["do it", RETRY_TEXT]);
  expect(failing.rotations).toEqual([true]);

  // no fork possible: no retry; the error text is cut at 120 characters; no fallbacks left reads "none"
  const error = `overloaded ${"x".repeat(200)}`;
  const unforked = fakeSession([{ text: "", error }], false);
  expect(await runRouted(unforked.session, "do it", chain(FLASH, []), "opencode-go")).toStrictEqual(
    {
      text: "",
      error,
      provider: `deepseek-v4.1-flash is failing (last error: ${error.slice(0, 120)}); other models: none`,
    },
  );
  expect(unforked.runs).toHaveLength(1);
  expect(unforked.rotations).toEqual([false]);

  // the retry succeeds: its result is returned
  const recovered = fakeSession([{ text: "", httpStatus: 429 }, { text: "ok" }]);
  expect(await runRouted(recovered.session, "do it", chain(FLASH, []), "opencode-go")).toEqual({
    text: "ok",
  });
});

test("runRouted: which errors count as transient", async () => {
  const retried = async (result: Omit<RunResult, "text">) => {
    const { session, runs } = fakeSession([{ text: "", ...result }, { text: "ok" }]);
    await runRouted(session, "do it", chain(FLASH, []), "opencode-go");
    return runs.length === 2;
  };
  expect(await retried({ httpStatus: 408 })).toBe(true);
  expect(await retried({ httpStatus: 429 })).toBe(true);
  expect(await retried({ httpStatus: 500 })).toBe(true);
  expect(await retried({ httpStatus: 599 })).toBe(true);
  for (const error of [
    "Overloaded",
    "model at capacity",
    "Rate Limit hit",
    "Too many requests",
    "timed out",
    "timeout",
    "time out",
    "please try again",
    "temporarily unavailable",
    "Upstream request failed",
    "ECONNRESET",
    "socket hang up",
    "fetch failed",
  ])
    expect(await retried({ error })).toBe(true);
  expect(await retried({ httpStatus: 401, error: "invalid api key" })).toBe(false);
  expect(await retried({ httpStatus: 499 })).toBe(false);
  expect(await retried({ httpStatus: 402 })).toBe(false);
  expect(await retried({ error: "" })).toBe(false);
});

test("runRouted with escalation: one prompt on that model; a limit is recorded, never fallen back from; no retry", async () => {
  const limit: Limit = { model: "opencode-go/deepseek-v4-pro", message: "limited", next: 0 };
  const limited = fakeSession([{ text: "", limit }]);
  const c = chain(FLASH, [QWEN]);
  expect(await runRouted(limited.session, "fix it", c, "opencode-go", PRO)).toStrictEqual({
    text: "",
    limit,
  });
  expect(limited.runs).toStrictEqual([{ text: "fix it", model: PRO, interrupt: undefined }]);
  expect(c).toStrictEqual({
    first: FLASH,
    current: FLASH,
    rest: [QWEN],
    limits: [limit],
    used: [],
  });

  const transient = fakeSession([{ text: "", httpStatus: 503 }]);
  expect(
    await runRouted(transient.session, "fix it", chain(FLASH, []), "opencode-go", PRO),
  ).toStrictEqual({ text: "", httpStatus: 503 });
  expect(transient.rotations).toEqual([]);

  // OpenRouter out of credits is BUDGET on escalation too
  const broke = fakeSession([{ text: "", httpStatus: 402 }]);
  expect(
    await runRouted(broke.session, "fix it", chain(FLASH, []), "openrouter", PRO),
  ).toStrictEqual({ text: "", httpStatus: 402, budget: "OpenRouter credits exhausted" });
});

test("runRouted: a 402 is BUDGET only on OpenRouter", async () => {
  const other = fakeSession([{ text: "", httpStatus: 402 }]);
  expect(await runRouted(other.session, "do it", chain(FLASH, []), "opencode-go")).toStrictEqual({
    text: "",
    httpStatus: 402,
  });
});

/** The BUDGET reason runRouted gives once each model in turn hits one of `limits`. */
async function budgetFor(provider: Provider["provider"], limits: Limit[]) {
  const { session } = fakeSession(limits.map((limit) => ({ text: "", limit })));
  const [first, ...rest] = limits.map((_, i): WorkerModel => ({
    providerID: provider,
    id: `m${i}`,
  }));
  return (await runRouted(session, "do it", chain(first, rest), provider)).budget;
}

test("the BUDGET reason: the Go window or the provider's rate limit, the bare ids once each, the earliest real reset", async () => {
  const hour = Date.now() + 3_600_000;
  const later = Date.now() + 2 * 3_600_000;
  const go = (
    model: string,
    next: number,
    message = "5h usage limit reached. It will reset",
  ): Limit => ({
    model,
    reason: "account_rate_limit",
    message,
    next,
  });
  expect(
    await budgetFor("opencode-go", [
      go("opencode-go/deepseek-v4.1-flash", later),
      go("opencode-go/qwen3.7-plus", hour),
      go("opencode-go/deepseek-v4.1-flash", later),
    ]),
  ).toBe(`Go 5h window exhausted for deepseek-v4.1-flash, qwen3.7-plus (resets ~${clock(hour)})`);
  expect(
    await budgetFor("opencode-go", [go("opencode-go/a", later, "Weekly Usage Limit Reached.")]),
  ).toBe(`Go weekly window exhausted for a (resets ~${clock(later)})`);
  expect(await budgetFor("opencode-go", [go("opencode-go/a", later, "slow down")])).toBe(
    `Go usage window exhausted for a (resets ~${clock(later)})`,
  );
  expect(
    await budgetFor("opencode-go", [
      { model: "opencode-go/a", message: "plain", next: later },
      { model: "opencode-go/b", reason: "free_tier_limit", message: "free", next: hour },
    ]),
  ).toBe(`Go free tier window exhausted for a, b (resets ~${clock(hour)})`);
  // a next under a minute away, or not finite, is only a backoff: the last limit's own text is quoted
  expect(
    await budgetFor("openrouter", [
      { model: "openrouter/x/a", message: "first", next: Date.now() + 30_000 },
      { model: "openrouter/x/b", message: "Resets tomorrow", next: Number.NaN },
    ]),
  ).toBe("OpenRouter rate limit on every allowed model: x/a, x/b (retry Resets tomorrow)");
  expect(
    await budgetFor("deepseek", [
      { model: "deepseek/a", reason: "other", message: "m", next: hour },
    ]),
  ).toBe(`DeepSeek rate limit on every allowed model: a (retry ~${clock(hour)})`);
});

test("clock: HH:MM today, the short date in front on another day", () => {
  const today = new Date();
  today.setHours(9, 7, 0, 0);
  expect(clock(today.getTime())).toBe("09:07");
  expect(clock(new Date(2020, 0, 5, 18, 30).getTime())).toBe("Jan 5 18:30");
});

test("the ledger file: XDG_STATE_HOME, or ~/.local/state when it is empty", () => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv("XDG_STATE_HOME", "/state");
  expect(ledgerFile()).toBe(join("/state", "cheapag", "spend.jsonl"));
  vi.stubEnv("XDG_STATE_HOME", "");
  expect(ledgerFile()).toBe(join(homedir(), ".local", "state", "cheapag", "spend.jsonl"));
});

test("the spend ledger: recorded lines, damaged lines skipped, windows, caps, escalation skips and balance use", () => {
  const state = mkdtempSync(join(tmpdir(), "cheapag-ledger-"));
  vi.stubEnv("XDG_STATE_HOME", state);
  const now = Date.parse("2026-11-20T10:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"], now });
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(state, { recursive: true, force: true });
  });
  const file = join(state, "cheapag", "spend.jsonl");

  // nothing spent: no folder, no file
  recordSpend({ "opencode-go/deepseek-v4.1-flash": 0, "opencode-go/qwen3.7-plus": -1 });
  expect(existsSync(join(state, "cheapag"))).toBe(false);
  expect(spendWindows()).toEqual([]);

  const hour = 3_600_000;
  const line = (hoursAgo: number, model: unknown, costUsd: unknown) =>
    JSON.stringify({ at: new Date(now - hoursAgo * hour).toISOString(), model, costUsd });
  mkdirSync(join(state, "cheapag"));
  writeFileSync(
    file,
    [
      line(1, "opencode-go/deepseek-v4.1-flash", 4),
      "torn{",
      line(1, "opencode-go/deepseek-v4-pro", 1.5),
      line(48, "opencode-go/deepseek-v4.1-flash", 6),
      "null",
      "5",
      "[]",
      line(2, "openrouter/a/b", 1.5),
      line(1, "m", "1"),
      line(1, 3, 1),
      line(29 * 24, "opencode-go/deepseek-v4.1-flash", 70),
      line(40 * 24, "opencode-go/qwen3.7-plus", 9),
      line(1, "opencode-go/zero", 0),
      JSON.stringify({ at: "bogus", model: "opencode-go/qwen3.8-flash", costUsd: 2 }),
      "",
    ].join("\n"),
  );

  expect(spendWindows()).toStrictEqual([
    {
      model: "opencode-go/deepseek-v4-pro",
      windows: [
        { window: "5h", spent: 1.5, capUsd: 3 },
        { window: "weekly", spent: 1.5, capUsd: 7.5 },
        { window: "monthly", spent: 1.5, capUsd: 15 },
      ],
    },
    {
      model: "opencode-go/deepseek-v4.1-flash",
      windows: [
        { window: "5h", spent: 4, capUsd: 16 },
        { window: "weekly", spent: 10, capUsd: 40 },
        { window: "monthly", spent: 80, capUsd: 80 },
      ],
    },
    {
      model: "openrouter/a/b",
      windows: [
        { window: "5h", spent: 1.5, capUsd: undefined },
        { window: "weekly", spent: 1.5, capUsd: undefined },
        { window: "monthly", spent: 1.5, capUsd: undefined },
      ],
    },
  ]);
  // a window ends just before `now` minus its length
  expect(spendWindows(now + 4 * hour).map((s) => s.windows[0].spent)).toEqual([0, 0, 0]);

  expect(capUse("opencode-go/deepseek-v4.1-flash")).toStrictEqual({
    used: 1,
    window: "monthly",
    capUsd: 80,
  });
  expect(capUse("opencode-go/deepseek-v4-pro")).toStrictEqual({
    used: 0.5,
    window: "5h",
    capUsd: 3,
  });
  expect(capUse("opencode-go/deepseek-v4-pro", 1)).toStrictEqual({
    used: 2.5 / 3,
    window: "5h",
    capUsd: 3,
  });
  // nothing in any window: the first window wins the tie
  expect(capUse("opencode-go/qwen3.8-flash")).toStrictEqual({ used: 0, window: "5h", capUsd: 6 });
  expect(capUse("openrouter/a/b")).toBeUndefined();

  const fresh = chain(FLASH, []);
  expect(escalationSkip(PRO, fresh, 0.8, { "opencode-go/deepseek-v4-pro": 1 })).toBe(
    "esc: skipped, deepseek-v4-pro at 83% of its tracked 5h cap ($3.00)",
  );
  expect(escalationSkip(PRO, fresh, 0.9, { "opencode-go/deepseek-v4-pro": 1 })).toBeUndefined();
  expect(escalationSkip(PRO, fresh, 0.5, { "opencode-go/qwen3.7-plus": 9 })).toBe(
    "esc: skipped, deepseek-v4-pro at 50% of its tracked 5h cap ($3.00)",
  );
  expect(escalationSkip({ providerID: "openrouter", id: "a/b" }, fresh, 0, {})).toBeUndefined();
  const limited = chain(FLASH, []);
  limited.limits.push({ model: "opencode-go/deepseek-v4-pro", message: "limited", next: 0 });
  expect(escalationSkip(PRO, limited, 0.5, {})).toBe(
    "esc: skipped, deepseek-v4-pro hit its usage limit in this job",
  );
  expect(escalationSkip(undefined, fresh, 0.8, {})).toBe(
    "esc: skipped, the escalation model is not allowed by this repo's consent",
  );
  expect(escalationSkip(undefined, chain({ providerID: "local", id: "x" }, []), 0.8, {})).toBe(
    "esc: skipped, no escalation model for the local server (set models.escalation, or allow it with /cheapag:allow)",
  );

  // the job's own spend counts once it is recorded: exactly at the cap is not past it
  expect(usedBalance({ "opencode-go/deepseek-v4.1-flash": 0.02 })).toBe(false);
  expect(usedBalance({ "openrouter/a/b": 5, "opencode-go/deepseek-v4-pro": 0 })).toBe(false);
  const before = readFileSync(file, "utf8");
  recordSpend({
    "opencode-go/deepseek-v4.1-flash": 0.02,
    "openrouter/a/b": 0,
    "opencode-go/qwen3.7-plus": 0.25,
  });
  expect(readFileSync(file, "utf8")).toBe(
    before +
      '{"at":"2026-11-20T10:00:00.000Z","model":"opencode-go/deepseek-v4.1-flash","costUsd":0.02}\n' +
      '{"at":"2026-11-20T10:00:00.000Z","model":"opencode-go/qwen3.7-plus","costUsd":0.25}\n',
  );
  expect(usedBalance({ "opencode-go/deepseek-v4.1-flash": 0 })).toBe(true);
});
