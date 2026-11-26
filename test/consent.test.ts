import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  acceptRoute,
  consentGate,
  describe as describeConsent,
  modelWarnings,
  presetHere,
  readConsent,
  routeMoved,
  writeConsent,
  type Consent,
} from "../src/consent.js";
import { fullRoute, type Route, type WorkerModel } from "../src/routing.js";
import { startFakeOpencode } from "./fake-opencode.js";
import {
  allowRepo,
  callText,
  hermeticHome as makeHome,
  homeEnv,
  serverEntry,
  startServer,
  tempRepo,
  type Logins,
} from "./harness.js";

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
const OPENROUTER_MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3.8-flash",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.7-plus",
  "z-ai/glm-5.3",
  "moonshotai/kimi-k3",
];

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
    const server = await startServer({
      cwd: repo.dir,
      env: { CHEAPAG_OPENCODE_URL: fake.url },
      logins,
      allow,
    });
    onTestFinished(server.close);
    return server;
  };
  const server = await start(opts.allow);
  const delegate = (client = server.client, extra: Record<string, unknown> = {}) =>
    callText(client, "delegate", { plan: "plan.md", steps: "1", ...extra });
  return { repo, fake, server, start, delegate, logins };
}

/** Nothing was created and nothing reached OpenCode, let alone a provider. */
function expectUntouched(repo: { dir: string }, fake: { recorded: { requests: unknown[] } }) {
  expect(existsSync(join(repo.dir, ".cheapag", "jobs"))).toBe(false);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees"))).toBe(false);
  expect(fake.recorded.requests).toEqual([]);
}

const opencodeConfig = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".cheapag", "opencode", "opencode.json"), "utf8"));

test("first delegate in an unapproved repo returns CONSENT and creates no job; after the developer allows it, the job runs", async () => {
  const { repo, fake, server, delegate, logins } = await scenario();
  const text = await delegate();
  expect(text).toBe(
    [
      `CONSENT repo=${basename(repo.dir)}`,
      "send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)",
      "retention: deepseek-v4.1-flash = zero retention; qwen3.8-flash = zero retention; deepseek-v4-pro = zero retention; qwen3.7-plus = zero retention; glm-5.3 = not stated; kimi-k3 = not stated",
      "approve: ask the user to run /cheapag:allow in Claude Code, or npx cheap-agent allow in a terminal (Codex); add --zdr-only to limit it to zero-retention models, or --models a,b; never approve yourself",
    ].join("\n"),
  );
  expectUntouched(repo, fake);

  // the developer approves from a terminal while the server keeps running
  const { env } = hermeticHome(logins);
  expect(allowRepo(repo.dir, env)).toContain("code may go to OpenCode Go (all models)");
  expect(
    JSON.parse(readFileSync(join(repo.dir, ".cheapag", "consent.json"), "utf8")),
  ).toMatchObject({ mode: "all", provider: "opencode-go" });
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
    expect(Object.keys(tool.inputSchema.properties ?? {}).join(" ")).not.toMatch(
      /allow|consent|approv/i,
    );
  }
  expect(await delegate(server.client, { consent: "all", allow: true })).toMatch(/^CONSENT /);
  expectUntouched(repo, fake);
});

test("zero-retention only blocks a model whose retention is not stated: FAIL no allowed model, nothing created", async () => {
  const { repo, fake, delegate } = await scenario({
    logins: { deepseek: "k" },
    allow: ["--zdr-only"],
  });
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
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { openrouter: "k" },
  });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: "plan.md", steps: "1" });
  expect(text).toMatch(/^CONSENT /);
  expect(text).toContain(
    "send: code from this repo → OpenRouter: deepseek/deepseek-v4.1-flash, qwen/qwen3.8-flash, z-ai/glm-5.3-flash (+fallbacks qwen/qwen3.7-plus, z-ai/glm-5.3, moonshotai/kimi-k3)\n",
  );
  expect(text).toContain(
    `retention: depends on the upstream provider OpenRouter routes to; "deny data collection" is always on;`,
  );
});

test("on one provider a model change after consent never asks again: the job runs on the new model", async () => {
  const { repo, fake, server, delegate } = await scenario({ allow: [] });
  // the developer re-runs login from a script on the server's own user config
  execFileSync(process.execPath, [serverEntry, "login", "--preset", "strongest"], {
    env: homeEnv(server.home),
    stdio: "pipe",
  });
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "opencode-go", id: "glm-5.3" });
  expect(readFileSync(join(repo.dir, "hello.txt"), "utf8")).toBe("hi\n");
});

test("on OpenRouter a model change after consent asks again until acceptRoute records it", async () => {
  const { repo, fake, server, delegate } = await scenario({
    logins: { openrouter: "k" },
    allow: [],
  });
  const config = join(server.home, "config", "cheapag", "config.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ models: { implement: "openrouter/z-ai/glm-5.3" } }));
  expect(await delegate()).toMatch(/^CONSENT /);
  expectUntouched(repo, fake);
  vi.stubEnv("XDG_CONFIG_HOME", join(server.home, "config"));
  onTestFinished(() => void vi.unstubAllEnvs());
  acceptRoute(repo.dir);
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  expect(fake.recorded.sessions[0].model).toEqual({ providerID: "openrouter", id: "z-ai/glm-5.3" });
});

test("OpenRouter zero-retention only adds its zdr routing preference to every model, on top of deny data collection", async () => {
  const { repo, fake, server, delegate } = await scenario({
    logins: { openrouter: "k" },
    allow: ["--zdr-only"],
  });
  // ping boots OpenCode on the default config first; the job must still get the zdr one
  expect(await callText(server.client, "ping")).toMatch(/^OK /);
  expect(
    opencodeConfig(repo.dir).provider.openrouter.models["deepseek/deepseek-v4.1-flash"].options
      .provider.zdr,
  ).toBeUndefined();
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  const zdr = { options: { provider: { data_collection: "deny", sort: "throughput", zdr: true } } };
  expect(opencodeConfig(repo.dir).provider).toEqual({
    openrouter: { models: Object.fromEntries(OPENROUTER_MODELS.map((id) => [id, zdr])) },
  });
});

test("an explicit list without the escalation model: verify failures skip escalation instead of using it", async () => {
  const { fake, delegate } = await scenario({
    allow: ["--models", "opencode-go/deepseek-v4.1-flash"],
    plan: PLAN("`test -f never-there`"),
  });
  fake.script(FINISH);
  const text = await delegate();
  expect(text).toMatch(/^FAIL j\w{4} step=1 .* fix=2\n/);
  expect(text).toContain(
    "\n  - esc: skipped, the escalation model is not allowed by this repo's consent\n",
  );
  expect(fake.recorded.prompts.every((p) => p.model?.modelID !== "deepseek-v4-pro")).toBe(true);
});

test("an explicit list with only the escalation model runs the job on it, title generation included", async () => {
  const { repo, fake, delegate } = await scenario({
    allow: ["--models", "opencode-go/deepseek-v4-pro"],
  });
  fake.script({ edit: "hello.txt", content: "hi\n" }, FINISH);
  expect(await delegate()).toMatch(/^OK /);
  expect(fake.recorded.sessions[0].model).toEqual({
    providerID: "opencode-go",
    id: "deepseek-v4-pro",
  });
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
  expect(fails(repo.dir, env, ["--everything"])).toContain(
    "usage: cheapag allow [--zdr-only | --models <provider/model,…>]",
  );
  expect(fails(repo.dir, hermeticHome().env, [])).toContain(
    "no worker provider; run npx cheap-agent login first",
  );
  mkdirSync(join(home, "not-a-repo"));
  expect(fails(join(home, "not-a-repo"), env, [])).toContain("is not inside a git repository");
  expect(existsSync(join(repo.dir, ".cheapag", "consent.json"))).toBe(false);
});

test("cheapag allow adds .cheapag/ to .git/info/exclude once, not again on a second run", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const exclude = join(repo.dir, ".git", "info", "exclude");
  writeFileSync(exclude, ""); // undo the harness's ignore rule
  const { env } = hermeticHome({ "opencode-go": "k" });
  expect(allowRepo(repo.dir, env)).toContain(".cheapag/ added to .git/info/exclude");
  allowRepo(repo.dir, env);
  expect(
    readFileSync(exclude, "utf8")
      .split("\n")
      .filter((l) => l === ".cheapag/"),
  ).toHaveLength(1);
});

/** A hermetic user config for in-process calls, with no Ollama key in the environment. */
function userConfig(config: object) {
  const { home } = hermeticHome();
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
  vi.stubEnv("OLLAMA_API_KEY", "");
  onTestFinished(() => void vi.unstubAllEnvs());
  mkdirSync(join(home, "config", "cheapag"), { recursive: true });
  writeFileSync(join(home, "config", "cheapag", "config.json"), JSON.stringify(config));
  return home;
}

test("a damaged consent record counts as none", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".cheapag"));
  writeFileSync(join(repo.dir, ".cheapag", "consent.json"), "{ not json");
  expect(readConsent(repo.dir)).toBeUndefined();
});

test("a damaged ollama entry is left to the config load: no route check and no model warnings here", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  userConfig({ ollama: { endpoint: "bogus" } });
  expect(
    routeMoved(repo.dir, {
      mode: "all",
      provider: "ollama",
      route: ["ollama/x"],
      approvedAt: "2026-11-01T00:00:00Z",
    }),
  ).toBe(false);
  expect(modelWarnings("ollama", repo.dir)).toEqual([]);
});

test("the CONSENT block names /cheapag:allow only when the session runs in that repo; elsewhere it asks for a terminal in the root", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const home = userConfig({});
  const cwd = vi.spyOn(process, "cwd");
  onTestFinished(() => {
    cwd.mockRestore();
  });
  const block = () => (consentGate(repo.dir, "opencode-go") as { block: string }).block;
  cwd.mockReturnValue(repo.dir);
  expect(block()).toContain(
    "ask the user to run /cheapag:allow in Claude Code, or npx cheap-agent allow in a terminal (Codex)",
  );
  cwd.mockReturnValue(home); // outside any repo
  expect(block()).toContain(
    "ask the user to run npx cheap-agent allow in a terminal in this root (/cheapag:allow approves the session's repo)",
  );
});

// Characterization of the gate's decision: block or route, and the exact text, per mode, provider and record state.

const AT = "2026-11-01T00:00:00.000Z";
const LOCAL = { base_url: "http://127.0.0.1:8084/v1", model: "qwen3.8-flash-next-gyro-gyro-s" };
const OLLAMA_LOCAL = { ollama: { endpoint: "local", model: "llama3.2" } };
const OLLAMA_CLOUD = { ollama: { endpoint: "cloud" } };
const APPROVE_HERE =
  "approve: ask the user to run /cheapag:allow in Claude Code, or npx cheap-agent allow in a terminal (Codex); add --zdr-only to limit it to zero-retention models, or --models a,b; never approve yourself";
const GO_SEND =
  "send: code from this repo → OpenCode Go: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks qwen3.7-plus, glm-5.3, kimi-k3)";
const GO_RETENTION =
  "retention: deepseek-v4.1-flash = zero retention; qwen3.8-flash = zero retention; deepseek-v4-pro = zero retention; qwen3.7-plus = zero retention; glm-5.3 = not stated; kimi-k3 = not stated";
const OPENROUTER_RETENTION = `retention: depends on the upstream provider OpenRouter routes to; "deny data collection" is always on; --zdr-only adds OpenRouter's zero-data-retention routing (zdr)`;

/** A repo the session runs in, with a hermetic user config holding `config`. */
function sessionRepo(config: object = {}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  userConfig(config);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(repo.dir);
  onTestFinished(() => {
    cwd.mockRestore();
  });
  return repo.dir;
}

const consentFile = (dir: string) => join(dir, ".cheapag", "consent.json");
const block = (dir: string, lines: string[]) =>
  [`CONSENT repo=${basename(dir)}`, ...lines, APPROVE_HERE].join("\n");
const goBlock = (dir: string) => block(dir, [GO_SEND, GO_RETENTION]);
const failText = (label: string, consent: string) =>
  `FAIL reason: no allowed model for ${label} under this repo's consent (${consent}); ask the user to widen it with /cheapag:allow`;

const go = (id: string): WorkerModel => ({ providerID: "opencode-go", id });
const openrouter = (id: string, zdr = false): WorkerModel => ({
  providerID: "openrouter",
  id,
  options: {
    provider: { data_collection: "deny", sort: "throughput", ...(zdr && { zdr: true }) },
  },
});
/** A gate route as consentGate builds it: every key present, unset ones undefined. */
const route = (r: Partial<Route> & Pick<Route, "implement" | "research">): Route => ({
  fallbacks: [],
  escalation: undefined,
  researchFallbacks: [],
  medium: undefined,
  hard: undefined,
  ...r,
});
const GO_ALL = route({
  implement: go("deepseek-v4.1-flash"),
  fallbacks: [go("qwen3.7-plus"), go("glm-5.3"), go("kimi-k3")],
  escalation: go("deepseek-v4-pro"),
  research: go("qwen3.8-flash"),
  researchFallbacks: [go("deepseek-v4.1-flash")],
});
const openrouterRoute = (zdr: boolean) =>
  route({
    implement: openrouter("deepseek/deepseek-v4.1-flash", zdr),
    fallbacks: [
      openrouter("qwen/qwen3.7-plus", zdr),
      openrouter("z-ai/glm-5.3", zdr),
      openrouter("moonshotai/kimi-k3", zdr),
    ],
    escalation: openrouter("z-ai/glm-5.3-flash", zdr),
    research: openrouter("qwen/qwen3.8-flash", zdr),
    researchFallbacks: [openrouter("deepseek/deepseek-v4.1-flash", zdr)],
  });

test.each([
  ["OpenCode Go", "opencode-go", {}, [GO_SEND, GO_RETENTION]],
  [
    "OpenCode Zen",
    "opencode",
    {},
    [
      "send: code from this repo → OpenCode Zen: deepseek-v4.1-flash, qwen3.8-flash, deepseek-v4-pro (+fallbacks glm-5.3, kimi-k3)",
      "retention: deepseek-v4.1-flash = not stated; qwen3.8-flash = not stated; deepseek-v4-pro = not stated; glm-5.3 = not stated; kimi-k3 = not stated",
    ],
  ],
  [
    "OpenRouter",
    "openrouter",
    {},
    [
      "send: code from this repo → OpenRouter: deepseek/deepseek-v4.1-flash, qwen/qwen3.8-flash, z-ai/glm-5.3-flash (+fallbacks qwen/qwen3.7-plus, z-ai/glm-5.3, moonshotai/kimi-k3)",
      OPENROUTER_RETENTION,
    ],
  ],
  [
    "DeepSeek",
    "deepseek",
    {},
    [
      "send: code from this repo → DeepSeek: deepseek-flash, deepseek-v4-pro",
      "retention: deepseek-flash = not stated; deepseek-v4-pro = not stated",
    ],
  ],
  [
    "Command Code",
    "commandcode",
    {},
    [
      "send: code from this repo → Command Code: deepseek/deepseek-v4.1-flash, deepseek/deepseek-v4-pro",
      "retention: deepseek/deepseek-v4.1-flash = not stated; deepseek/deepseek-v4-pro = not stated",
    ],
  ],
  [
    "Ollama Cloud",
    "ollama",
    OLLAMA_CLOUD,
    [
      "send: code from this repo → Ollama Cloud (ollama.com): deepseek-v4.1-flash:cloud, qwen3.8-flash:cloud, glm-5.3:cloud (+fallbacks glm-5.3-flash:cloud, qwen3.7-plus:cloud)",
      "retention: Ollama Cloud's terms (ollama.com); retention is not stated here",
    ],
  ],
  [
    "a local Ollama",
    "ollama",
    OLLAMA_LOCAL,
    [
      "send: code from this repo → your local Ollama at http://127.0.0.1:11434/v1: llama3.2",
      "retention: nothing leaves this machine: your own Ollama keeps what it is set up to keep",
    ],
  ],
  [
    "a custom endpoint",
    "local",
    { local: LOCAL },
    [
      "send: code from this repo → custom endpoint at http://127.0.0.1:8084/v1: qwen3.8-flash-next-gyro-gyro-s",
      "retention: up to the endpoint: your own server keeps what it is set up to keep; a gateway or vendor keeps what its terms say",
    ],
  ],
] as const)(
  "with no consent record the gate returns the exact CONSENT block for %s",
  (_, provider, config, lines) => {
    const dir = sessionRepo(config);
    expect(consentGate(dir, provider)).toStrictEqual({ block: block(dir, [...lines]) });
  },
);

test("the CONSENT block for a repo outside the session asks for a terminal in that root, in full", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const home = userConfig({});
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
  onTestFinished(() => {
    cwd.mockRestore();
  });
  expect(consentGate(repo.dir, "opencode-go")).toStrictEqual({
    block: [
      `CONSENT repo=${basename(repo.dir)}`,
      GO_SEND,
      GO_RETENTION,
      "approve: ask the user to run npx cheap-agent allow in a terminal in this root (/cheapag:allow approves the session's repo); add --zdr-only or --models a,b to narrow it; never approve yourself",
    ].join("\n"),
  });
});

test.each([
  ["broken JSON", "{ not json"],
  ["null", "null"],
  ["a number", "42"],
  ["an array", "[]"],
  ["an unknown mode", '{"mode":"some","provider":"opencode-go","approvedAt":"x"}'],
  ["a provider that is not a string", '{"mode":"all","provider":7,"approvedAt":"x"}'],
  ["the models mode without a models list", '{"mode":"models","provider":"opencode-go"}'],
  [
    "the models mode with a string for models",
    '{"mode":"models","provider":"opencode-go","models":"opencode-go/kimi-k3"}',
  ],
  [
    "the models mode with a non-string model",
    '{"mode":"models","provider":"opencode-go","models":[1]}',
  ],
])("a consent record holding %s counts as none: the gate shows the CONSENT block", (_, text) => {
  const dir = sessionRepo();
  mkdirSync(join(dir, ".cheapag"));
  writeFileSync(consentFile(dir), text);
  expect(readConsent(dir)).toBeUndefined();
  expect(consentGate(dir, "opencode-go")).toStrictEqual({ block: goBlock(dir) });
});

test("a consent record that cannot be read (a directory) counts as none", () => {
  const dir = sessionRepo();
  mkdirSync(consentFile(dir), { recursive: true });
  expect(readConsent(dir)).toBeUndefined();
  expect(consentGate(dir, "opencode-go")).toStrictEqual({ block: goBlock(dir) });
});

test("readConsent returns a valid record as stored: extra keys kept, models and route unchecked outside the models mode", () => {
  const dir = sessionRepo();
  mkdirSync(join(dir, ".cheapag"));
  const stored = { mode: "all", provider: "opencode-go", models: 5, route: "x", extra: true };
  writeFileSync(consentFile(dir), JSON.stringify(stored));
  expect(readConsent(dir)).toStrictEqual(stored);
});

test("a consent given for another provider blocks with this provider's own CONSENT block", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "all", provider: "opencode-go", approvedAt: AT });
  expect(consentGate(dir, "deepseek")).toStrictEqual({
    block: block(dir, [
      "send: code from this repo → DeepSeek: deepseek-flash, deepseek-v4-pro",
      "retention: deepseek-flash = not stated; deepseek-v4-pro = not stated",
    ]),
  });
});

test("consent all on OpenCode Go gives the whole route", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "all", provider: "opencode-go", approvedAt: AT });
  expect(consentGate(dir, "opencode-go")).toStrictEqual({ route: GO_ALL });
});

test("zero-retention only on OpenCode Go keeps only its DeepSeek and Qwen models", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "zdr-only", provider: "opencode-go", approvedAt: AT });
  expect(consentGate(dir, "opencode-go")).toStrictEqual({
    route: route({
      implement: go("deepseek-v4.1-flash"),
      fallbacks: [go("qwen3.7-plus")],
      escalation: go("deepseek-v4-pro"),
      research: go("qwen3.8-flash"),
      researchFallbacks: [go("deepseek-v4.1-flash")],
    }),
  });
});

test.each([
  ["all", false],
  ["zdr-only", true],
] as const)(
  "consent %s on OpenRouter keeps every model (zdr routing added: %s) and leaves the default route untouched",
  (mode, zdr) => {
    const dir = sessionRepo();
    writeConsent(dir, { mode, provider: "openrouter", approvedAt: AT });
    expect(consentGate(dir, "openrouter")).toStrictEqual({ route: openrouterRoute(zdr) });
    expect(fullRoute("openrouter").implement).toStrictEqual(
      openrouter("deepseek/deepseek-v4.1-flash"),
    );
  },
);

test.each([
  ["all", OLLAMA_LOCAL, "ollama", "llama3.2"],
  ["zdr-only", OLLAMA_LOCAL, "ollama", "llama3.2"],
  ["all", { local: LOCAL }, "local", LOCAL.model],
] as const)(
  "consent %s on a config endpoint (%j) gives its one model, with no escalation",
  (mode, config, provider, id) => {
    const dir = sessionRepo(config);
    writeConsent(dir, { mode, provider, approvedAt: AT });
    const model = { providerID: provider, id };
    expect(consentGate(dir, provider)).toStrictEqual({
      route: route({ implement: model, research: model }),
    });
  },
);

test.each([
  ["OpenCode Zen", "opencode", {}],
  ["DeepSeek", "deepseek", {}],
  ["Command Code", "commandcode", {}],
  ["Ollama", "ollama", OLLAMA_CLOUD],
  ["Custom endpoint", "local", { local: LOCAL }],
] as const)(
  "zero-retention only on %s has no allowed model: the exact FAIL",
  (label, provider, config) => {
    const dir = sessionRepo(config);
    writeConsent(dir, { mode: "zdr-only", provider, approvedAt: AT });
    expect(consentGate(dir, provider)).toStrictEqual({
      block: failText(label, "zero-retention only"),
    });
  },
);

test.each([
  [
    "a fallback and the escalation model: the fallback implements and researches",
    ["opencode-go/qwen3.7-plus", "opencode-go/deepseek-v4-pro"],
    {},
    route({
      implement: go("qwen3.7-plus"),
      escalation: go("deepseek-v4-pro"),
      research: go("qwen3.7-plus"),
    }),
  ],
  [
    "only the escalation model: it implements, and is not also the escalation",
    ["opencode-go/deepseek-v4-pro"],
    {},
    route({ implement: go("deepseek-v4-pro"), research: go("deepseek-v4-pro") }),
  ],
  [
    "two fallbacks: research runs on the implement chain",
    ["opencode-go/glm-5.3", "opencode-go/kimi-k3"],
    {},
    route({
      implement: go("glm-5.3"),
      fallbacks: [go("kimi-k3")],
      research: go("glm-5.3"),
      researchFallbacks: [go("kimi-k3")],
    }),
  ],
  [
    "tier models: an allowed one is kept, a disallowed one dropped",
    ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3"],
    { models: { medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" } },
    route({
      implement: go("deepseek-v4.1-flash"),
      fallbacks: [go("glm-5.3")],
      research: go("deepseek-v4.1-flash"),
      medium: go("glm-5.3"),
    }),
  ],
  [
    "tier models: a disallowed medium is dropped, an allowed hard kept",
    ["opencode-go/deepseek-v4.1-flash", "opencode-go/kimi-k3"],
    { models: { medium: "opencode-go/glm-5.3", hard: "opencode-go/kimi-k3" } },
    route({
      implement: go("deepseek-v4.1-flash"),
      fallbacks: [go("kimi-k3")],
      research: go("deepseek-v4.1-flash"),
      hard: go("kimi-k3"),
    }),
  ],
])("an explicit model list with %s", (_, models, config, expected) => {
  const dir = sessionRepo(config);
  writeConsent(dir, { mode: "models", provider: "opencode-go", models, approvedAt: AT });
  expect(consentGate(dir, "opencode-go")).toStrictEqual({ route: expected });
});

test("consent all never lists the escalation model as a fallback too", () => {
  const dir = sessionRepo({
    models: { fallback: ["opencode-go/deepseek-v4-pro", "opencode-go/glm-5.3"] },
  });
  writeConsent(dir, { mode: "all", provider: "opencode-go", approvedAt: AT });
  expect(consentGate(dir, "opencode-go")).toStrictEqual({
    route: { ...GO_ALL, fallbacks: [go("glm-5.3")] },
  });
});

test.each([
  ["only the research model", ["opencode-go/qwen3.8-flash"], "models opencode-go/qwen3.8-flash"],
  ["no model at all", [], "models "],
])("an explicit model list with %s fails with the exact FAIL", (_, models, described) => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "models", provider: "opencode-go", models, approvedAt: AT });
  expect(consentGate(dir, "opencode-go")).toStrictEqual({
    block: failText("OpenCode Go", described),
  });
});

test("on OpenRouter a changed route blocks with the CONSENT block for the new route", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "all", provider: "openrouter", approvedAt: AT });
  userConfig({ models: { implement: "openrouter/z-ai/glm-5.3" } });
  expect(routeMoved(dir, readConsent(dir)!)).toBe(true);
  expect(consentGate(dir, "openrouter")).toStrictEqual({
    block: block(dir, [
      "send: code from this repo → OpenRouter: z-ai/glm-5.3, qwen/qwen3.8-flash, z-ai/glm-5.3-flash (+fallbacks qwen/qwen3.7-plus, moonshotai/kimi-k3, deepseek/deepseek-v4.1-flash)",
      OPENROUTER_RETENTION,
    ]),
  });
});

test("on OpenRouter a record from before routes were kept is not judged on its route", () => {
  const dir = sessionRepo({ models: { implement: "openrouter/z-ai/glm-5.3" } });
  mkdirSync(join(dir, ".cheapag"));
  writeFileSync(
    consentFile(dir),
    JSON.stringify({ mode: "all", provider: "openrouter", approvedAt: AT }),
  );
  expect(routeMoved(dir, readConsent(dir)!)).toBe(false);
  expect("route" in consentGate(dir, "openrouter")).toBe(true);
});

test("on OpenRouter a damaged repo config is not judged: no route change, and the gate gives the default route", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "all", provider: "openrouter", approvedAt: AT });
  userConfig({ models: { implement: "openrouter/z-ai/glm-5.3" } });
  writeFileSync(join(dir, "cheapag.json"), "{ bad");
  expect(routeMoved(dir, readConsent(dir)!)).toBe(false);
  expect(consentGate(dir, "openrouter")).toStrictEqual({ route: openrouterRoute(false) });
});

test("on OpenCode Go a changed route is never judged, and the new implement model leaves the fallbacks", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "all", provider: "opencode-go", approvedAt: AT });
  userConfig({ models: { implement: "opencode-go/glm-5.3" } });
  expect(routeMoved(dir, readConsent(dir)!)).toBe(false);
  expect(consentGate(dir, "opencode-go")).toStrictEqual({
    route: { ...GO_ALL, implement: go("glm-5.3"), fallbacks: [go("qwen3.7-plus"), go("kimi-k3")] },
  });
});

test("a damaged Ollama or custom endpoint entry makes the gate throw the config's own error", () => {
  const dir = sessionRepo({ ollama: { endpoint: "bogus" } });
  expect(() => consentGate(dir, "ollama")).toThrow(
    /: ollama\.endpoint must be "local" or "cloud"$/,
  );
  userConfig({ local: { base_url: "nope" } });
  expect(() => consentGate(dir, "local")).toThrow(
    /: local\.base_url must be an http\(s\) URL, e\.g\. http:\/\/127\.0\.0\.1:8080\/v1$/,
  );
});

test("writeConsent writes the record with the route it was shown, key order kept, and a final newline", () => {
  const dir = sessionRepo();
  writeConsent(dir, { mode: "all", provider: "opencode-go", approvedAt: AT });
  expect(readFileSync(consentFile(dir), "utf8")).toBe(
    `{
  "mode": "all",
  "provider": "opencode-go",
  "approvedAt": "${AT}",
  "route": [
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/qwen3.8-flash",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/qwen3.7-plus",
    "opencode-go/glm-5.3",
    "opencode-go/kimi-k3"
  ]
}
`,
  );
});

test("writeConsent replaces a stale route in its place, drops it for an explicit list, and never changes its argument", () => {
  const dir = sessionRepo({ models: { fallback: ["opencode-go/glm-5.3"] } });
  const stale: Consent = { mode: "all", provider: "opencode-go", route: ["old"], approvedAt: "x" };
  writeConsent(dir, stale);
  expect(stale).toStrictEqual({
    mode: "all",
    provider: "opencode-go",
    route: ["old"],
    approvedAt: "x",
  });
  expect(readFileSync(consentFile(dir), "utf8")).toBe(
    `{
  "mode": "all",
  "provider": "opencode-go",
  "route": [
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/qwen3.8-flash",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/glm-5.3"
  ],
  "approvedAt": "x"
}
`,
  );
  const listed: Consent = {
    mode: "models",
    provider: "opencode-go",
    models: ["opencode-go/kimi-k3"],
    route: ["old"],
    approvedAt: "x",
  };
  writeConsent(dir, listed);
  expect(listed.route).toEqual(["old"]);
  expect(readFileSync(consentFile(dir), "utf8")).toBe(
    `{
  "mode": "models",
  "provider": "opencode-go",
  "models": [
    "opencode-go/kimi-k3"
  ],
  "approvedAt": "x"
}
`,
  );
});

test.each([
  ["a local Ollama", "ollama", OLLAMA_LOCAL, ["ollama/llama3.2@http://127.0.0.1:11434/v1"]],
  [
    "Ollama Cloud",
    "ollama",
    OLLAMA_CLOUD,
    [
      "ollama/deepseek-v4.1-flash:cloud",
      "ollama/qwen3.8-flash:cloud",
      "ollama/glm-5.3:cloud",
      "ollama/glm-5.3-flash:cloud",
      "ollama/qwen3.7-plus:cloud",
    ],
  ],
  [
    "a custom endpoint",
    "local",
    { local: LOCAL },
    ["local/qwen3.8-flash-next-gyro-gyro-s@http://127.0.0.1:8084/v1"],
  ],
] as const)(
  "the recorded route for %s names a server's URL only when it is a recipient",
  (_, provider, config, names) => {
    const dir = sessionRepo(config);
    writeConsent(dir, { mode: "zdr-only", provider, approvedAt: AT });
    expect(JSON.parse(readFileSync(consentFile(dir), "utf8")).route).toEqual(names);
  },
);

test("acceptRoute writes nothing without consent, and records the current route with one", () => {
  const dir = sessionRepo();
  acceptRoute(dir);
  expect(existsSync(join(dir, ".cheapag"))).toBe(false);
  writeConsent(dir, { mode: "all", provider: "openrouter", approvedAt: AT });
  userConfig({ models: { implement: "openrouter/z-ai/glm-5.3" } });
  acceptRoute(dir);
  expect(JSON.parse(readFileSync(consentFile(dir), "utf8"))).toStrictEqual({
    mode: "all",
    provider: "openrouter",
    approvedAt: AT,
    route: [
      "openrouter/z-ai/glm-5.3",
      "openrouter/qwen/qwen3.8-flash",
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/qwen/qwen3.7-plus",
      "openrouter/moonshotai/kimi-k3",
      "openrouter/deepseek/deepseek-v4.1-flash",
    ],
  });
});

test("describe names each mode, and throws on the models mode without a list (readConsent never returns one)", () => {
  const base = { provider: "opencode-go", approvedAt: AT } as const;
  expect(describeConsent({ ...base, mode: "all" })).toBe("all models");
  expect(describeConsent({ ...base, mode: "zdr-only" })).toBe("zero-retention only");
  expect(describeConsent({ ...base, mode: "models", models: ["a/b", "c/d"] })).toBe(
    "models a/b, c/d",
  );
  expect(() => describeConsent({ ...base, mode: "models" })).toThrow(TypeError);
});

test("presetHere reads the repo root's config inside a repo, and the cwd's own outside one", () => {
  const { home } = hermeticHome();
  userConfig({ preset: "strongest" });
  const outside = join(home, "outside");
  mkdirSync(outside);
  expect(presetHere("opencode-go", outside)).toBe("strongest");
  writeFileSync(join(outside, "cheapag.json"), JSON.stringify({ preset: "balanced" }));
  expect(presetHere("opencode-go", outside)).toBe("balanced");
  // a damaged config counts as no models at all, not as the user's preset
  writeFileSync(join(outside, "cheapag.json"), "{ bad");
  expect(presetHere("opencode-go", outside)).toBe("balanced");

  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "sub"));
  writeFileSync(join(repo.dir, "sub", "cheapag.json"), JSON.stringify({ preset: "balanced" }));
  expect(presetHere("opencode-go", join(repo.dir, "sub"))).toBe("strongest");
  writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify({ preset: "balanced" }));
  expect(presetHere("opencode-go", join(repo.dir, "sub"))).toBe("balanced");
});
