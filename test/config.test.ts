import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  addAllowCommand,
  chosenProvider,
  loadConfig,
  localServer,
  OLLAMA_CLOUD_URL,
  OLLAMA_LOCAL_URL,
  ollamaConfig,
  ollamaEndpoint,
  ollamaIsLocal,
  privateHost,
  userConfigFile,
} from "../src/config.js";
import { hermeticHome, homeEnv, tempRepo } from "./harness.js";

/** Config validation for keys that only the user config may set. */

function setup(user: object, repoConfig?: object) {
  const h = hermeticHome({});
  const file = join(h.home, "config", "cheapag", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(user));
  for (const [key, value] of Object.entries(homeEnv(h.home)))
    if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  const repo = tempRepo();
  onTestFinished(() => {
    vi.unstubAllEnvs();
    repo.cleanup();
  });
  if (repoConfig) writeFileSync(join(repo.dir, "cheapag.json"), JSON.stringify(repoConfig));
  return { dir: repo.dir, file };
}

test("preset: a user config preset loads, an unknown one names the allowed values, a repo cannot set it", () => {
  expect(loadConfig(setup({ preset: "balanced" }).dir).preset).toBe("balanced");
  expect(() => loadConfig(setup({ preset: "fast" }).dir)).toThrow(
    "preset must be one of cheapest, balanced, strongest",
  );
  expect(() => loadConfig(setup({}, { preset: "balanced" }).dir)).toThrow(
    /preset can only be set in .*config\.json/,
  );
});

test("models.variants: a map of full model names to efforts loads; a non-string effort is refused", () => {
  const variants = { "opencode-go/deepseek-v4.1-flash": "high", "opencode-go/glm-5.3": "max" };
  expect(loadConfig(setup({ models: { variants } }).dir).models.variants).toEqual(variants);
  expect(() =>
    loadConfig(setup({ models: { variants: { "opencode-go/glm-5.3": 2 } } }).dir),
  ).toThrow(
    'models.variants must map provider/model names to an effort, e.g. {"opencode-go/deepseek-v4.1-flash": "high"}',
  );
});

test("on_blocked_command: ask is the default; deny stays; anything else is named", () => {
  expect(loadConfig(setup({}).dir).on_blocked_command).toBe("ask");
  expect(loadConfig(setup({ on_blocked_command: "deny" }).dir).on_blocked_command).toBe("deny");
  expect(() => loadConfig(setup({ on_blocked_command: "bogus" }).dir)).toThrow(
    "on_blocked_command must be one of ask, deny",
  );
});

test("takeover: ask is the default; sonnet and self stay; an unknown mode names all three", () => {
  expect(loadConfig(setup({}).dir).takeover).toBe("ask");
  expect(loadConfig(setup({ takeover: "sonnet" }).dir).takeover).toBe("sonnet");
  expect(loadConfig(setup({ takeover: "self" }).dir).takeover).toBe("self");
  expect(() => loadConfig(setup({ takeover: "bogus" }).dir)).toThrow(
    "takeover must be one of sonnet, self, ask",
  );
});

test("a config file that cannot be read or parsed fails naming the file and the cause", () => {
  const { dir } = setup({});
  writeFileSync(join(dir, "cheapag.json"), "{ not json");
  expect(() => loadConfig(dir)).toThrow(/cheapag\.json is not valid JSON: /);
  const unreadable = setup({}).dir;
  mkdirSync(join(unreadable, "cheapag.json")); // a folder where the file belongs
  expect(() => loadConfig(unreadable)).toThrow(/^cannot read .*cheapag\.json: /);
});

test("allow_commands, escalation_skip_at and guard_lines: valid values load, anything else is named", () => {
  expect(
    loadConfig(
      setup({ allow_commands: [" make test "], escalation_skip_at: 1, guard_lines: 5 }).dir,
    ),
  ).toMatchObject({ allow_commands: ["make test"], escalation_skip_at: 1, guard_lines: 5 });
  for (const bad of ["make", [""], [1]])
    expect(() => loadConfig(setup({ allow_commands: bad }).dir)).toThrow(
      "allow_commands must be a list of commands",
    );
  for (const bad of [0, 1.5, "0.5"])
    expect(() => loadConfig(setup({ escalation_skip_at: bad }).dir)).toThrow(
      "escalation_skip_at must be a number above 0 and at most 1",
    );
  for (const bad of [0, 2.5, "3"])
    expect(() => loadConfig(setup({ guard_lines: bad }).dir)).toThrow(
      "guard_lines must be a positive whole number",
    );
});

test("privateHost is false for something that is not a URL", () => {
  expect(privateHost("not a url")).toBe(false);
  expect(privateHost("")).toBe(false);
});

/** The class and message of the error `run` throws, so a test pins both exactly. */
function thrown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  throw new Error("expected a throw");
}

/** A hermetic home with no user config file, with this process's XDG paths pointed at it; returns where the file goes. */
function emptyHome() {
  const h = hermeticHome({});
  for (const [key, value] of Object.entries(homeEnv(h.home)))
    if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  vi.stubEnv("OLLAMA_API_KEY", "");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const file = join(h.home, "config", "cheapag", "config.json");
  mkdirSync(join(file, ".."), { recursive: true });
  return file;
}

/**
 * Starts from `start`, expects each message in turn and applies the fix after it, then expects a clean load: the
 * order a file's mistakes are reported in.
 */
function expectReportOrder(
  start: Record<string, unknown>,
  fixes: [message: string, fix: Record<string, unknown>][],
  load: (config: Record<string, unknown>) => unknown,
) {
  const config = { ...start };
  for (const [message, fix] of fixes) {
    expect(thrown(() => load(config))).toEqual(message);
    Object.assign(config, fix);
  }
  expect(() => load(config)).not.toThrow();
}

test("with empty config files, loadConfig gives the defaults, in this key order", () => {
  const config = loadConfig(setup({}).dir);
  expect(config).toEqual({
    link_dirs: ["node_modules", ".venv", "venv", "vendor"],
    allow_commands: ["npx tsc --noEmit"],
    limits: {
      max_turns: 25,
      max_minutes: 20,
      max_cost_usd: 0.5,
      max_parallel: 3,
      max_blocked_minutes: 60,
      repro_by_turns: 30,
      takeover_calls: 15,
    },
    retention: { unlanded_worktree_days: 2, job_log_days: 7 },
    models: {},
    escalation_skip_at: 0.8,
    guard_lines: 20,
    hard_tasks: "delegate",
    takeover: "ask",
    on_blocked_command: "ask",
  });
  expect(Object.keys(config)).toEqual([
    "link_dirs",
    "allow_commands",
    "limits",
    "retention",
    "models",
    "escalation_skip_at",
    "guard_lines",
    "hard_tasks",
    "takeover",
    "on_blocked_command",
  ]);
  expect(Object.keys(config.limits)).toEqual([
    "max_turns",
    "max_minutes",
    "max_cost_usd",
    "max_parallel",
    "max_blocked_minutes",
    "repro_by_turns",
    "takeover_calls",
  ]);
});

test("the repo's file overrides the user's; limits, retention and models merge key by key; user-only keys stay out", () => {
  const user = {
    test_cmd: "npm test",
    preset: "balanced",
    limits: { max_turns: 10, max_minutes: 5 },
    retention: { job_log_days: 1 },
    models: { implement: "a/b", variants: { "a/b": "high" } },
    link_dirs: ["deps"],
    allow_commands: ["make"],
    guard_lines: 7,
    provider: "opencode-go",
    local: { base_url: "http://127.0.0.1:8080/v1", model: "m" },
    ollama: { endpoint: "cloud" },
  };
  const repo = {
    test_cmd: "make test",
    integration_cmd: "make it",
    limits: { max_turns: 3 },
    retention: { unlanded_worktree_days: 0 },
    models: { hard: "c/d", variants: { "c/d": "max" } },
    link_dirs: [],
    takeover: "self",
  };
  const config = loadConfig(setup(user, repo).dir);
  expect(config).toEqual({
    link_dirs: [],
    allow_commands: ["make"],
    limits: {
      max_turns: 3,
      max_minutes: 5,
      max_cost_usd: 0.5,
      max_parallel: 3,
      max_blocked_minutes: 60,
      repro_by_turns: 30,
      takeover_calls: 15,
    },
    retention: { unlanded_worktree_days: 0, job_log_days: 1 },
    models: { implement: "a/b", variants: { "c/d": "max" }, hard: "c/d" },
    escalation_skip_at: 0.8,
    guard_lines: 7,
    hard_tasks: "delegate",
    takeover: "self",
    on_blocked_command: "ask",
    test_cmd: "make test",
    preset: "balanced",
    integration_cmd: "make it",
  });
  expect(Object.keys(config).slice(-3)).toEqual(["test_cmd", "preset", "integration_cmd"]);
  expect(Object.keys(config.models)).toEqual(["implement", "variants", "hard"]);
});

test("integration_cmd null in the repo leaves the user's; an unknown model role and limit key pass through or are ignored", () => {
  const { dir } = setup(
    { integration_cmd: "make it" },
    {
      integration_cmd: null,
      models: { implement: "a/b", foo: 1 },
      limits: { self_fix_attempts: 3 },
      allow_commands: [],
    },
  );
  const config = loadConfig(dir);
  expect(config.integration_cmd).toBe("make it");
  expect(config.models).toEqual({ implement: "a/b", foo: 1 });
  expect(config.limits).not.toHaveProperty("self_fix_attempts");
  expect(config.allow_commands).toEqual([]);
  expect("integration_cmd" in loadConfig(setup({ integration_cmd: null }).dir)).toBe(false);
});

test("a file with several mistakes reports them one at a time, in a fixed order", () => {
  const { dir, file } = setup({});
  expectReportOrder(
    {
      provider: 1,
      local: [],
      ollama: [],
      preset: "fast",
      limits: [],
      retention: [],
      allow_commands: "make",
      models: [],
      escalation_skip_at: 2,
      hard_tasks: "opus",
      takeover: "opus",
      on_blocked_command: "opus",
      guard_lines: 0,
      test_cmd: " ",
      integration_cmd: " ",
      link_dirs: "deps",
    },
    (
      [
        [
          "provider must be a provider id, e.g. opencode-go; switch with cheapag provider",
          { provider: undefined },
        ],
        ["local must be an object", { local: undefined }],
        ["ollama must be an object", { ollama: undefined }],
        ["preset must be one of cheapest, balanced, strongest", { preset: undefined }],
        ["limits must be an object", { limits: undefined }],
        ["retention must be an object", { retention: undefined }],
        ["allow_commands must be a list of commands", { allow_commands: undefined }],
        ["models must be an object", { models: undefined }],
        [
          "escalation_skip_at must be a number above 0 and at most 1",
          { escalation_skip_at: undefined },
        ],
        ["hard_tasks must be one of delegate, self, sonnet", { hard_tasks: undefined }],
        ["takeover must be one of sonnet, self, ask", { takeover: undefined }],
        ["on_blocked_command must be one of ask, deny", { on_blocked_command: undefined }],
        ["guard_lines must be a positive whole number", { guard_lines: undefined }],
        ["test_cmd must be a non-empty string", { test_cmd: undefined }],
        ["integration_cmd must be a non-empty string", { integration_cmd: undefined }],
        ["link_dirs must be a list of directory paths", { link_dirs: undefined }],
      ] as [string, Record<string, unknown>][]
    ).map(([message, fix]) => [`Error: ${file}: ${message}`, fix]),
    (config) => {
      writeFileSync(file, JSON.stringify(config));
      return loadConfig(dir);
    },
  );
});

test("keys only the user config may set are refused in a repo before their values are checked", () => {
  const user = userConfigFile;
  for (const [config, message] of [
    [{ provider: 1 }, () => `provider can only be set in ${user()}`],
    [{ local: 1 }, () => `local can only be set in ${user()}, never in a repo`],
    [{ ollama: 1 }, () => `ollama can only be set in ${user()}, never in a repo`],
    [{ preset: 1 }, () => `preset can only be set in ${user()}`],
  ] as const) {
    const { dir } = setup({}, config);
    expect(thrown(() => loadConfig(dir))).toBe(`Error: ${join(dir, "cheapag.json")}: ${message()}`);
  }
  // the user config is read first, so its mistake is the one reported
  const both = setup({ guard_lines: 0 }, { guard_lines: 0 });
  expect(thrown(() => loadConfig(both.dir))).toBe(
    `Error: ${both.file}: guard_lines must be a positive whole number`,
  );
});

test("a config file must hold a JSON object", () => {
  for (const text of ["[]", "null", '"text"', "3"]) {
    const { dir } = setup({});
    writeFileSync(join(dir, "cheapag.json"), text);
    expect(thrown(() => loadConfig(dir))).toBe(
      `Error: ${join(dir, "cheapag.json")} must hold a JSON object`,
    );
  }
  const { dir, file } = setup({});
  writeFileSync(file, "{ not json");
  expect(thrown(() => loadConfig(dir))).toMatch(
    new RegExp(`^Error: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON: \\S`),
  );
});

test("limits: each cap's message says positive or non-negative, whole number or number; caps are checked in a fixed order", () => {
  const { dir, file } = setup({});
  const load = (text: string) => {
    writeFileSync(file, text);
    return loadConfig(dir);
  };
  const message = (text: string) => thrown(() => load(text));
  const prefix = `Error: ${file}: limits.`;
  for (const [limits, expected] of [
    ['{"max_turns":0}', "max_turns must be a positive whole number"],
    ['{"max_turns":2.5}', "max_turns must be a positive whole number"],
    ['{"max_minutes":"20"}', "max_minutes must be a positive number"],
    ['{"max_minutes":0}', "max_minutes must be a positive number"],
    ['{"max_cost_usd":1e999}', "max_cost_usd must be a positive number"],
    ['{"max_parallel":1.5}', "max_parallel must be a positive whole number"],
    ['{"max_blocked_minutes":-1}', "max_blocked_minutes must be a positive number"],
    ['{"repro_by_turns":0}', "repro_by_turns must be a positive whole number"],
    ['{"takeover_calls":-1}', "takeover_calls must be a non-negative whole number"],
    ['{"takeover_calls":2.5}', "takeover_calls must be a non-negative whole number"],
    ['{"takeover_calls":-1,"max_turns":0}', "max_turns must be a positive whole number"],
    ['{"repro_by_turns":0,"max_parallel":0}', "max_parallel must be a positive whole number"],
  ])
    expect(message(`{"limits":${limits}}`)).toBe(prefix + expected);
  expect(
    load(
      '{"limits":{"takeover_calls":0,"max_minutes":5e-324,"max_cost_usd":0.01,"max_blocked_minutes":0.5}}',
    ).limits,
  ).toMatchObject({
    takeover_calls: 0,
    max_minutes: 5e-324,
    max_cost_usd: 0.01,
    max_blocked_minutes: 0.5,
  });
  expect(message('{"limits":null}')).toBe(`Error: ${file}: limits must be an object`);
  const caps = [
    "max_turns",
    "max_minutes",
    "max_cost_usd",
    "max_parallel",
    "max_blocked_minutes",
    "repro_by_turns",
    "takeover_calls",
  ];
  expectReportOrder(
    Object.fromEntries(caps.map((key) => [key, -1])),
    caps.map((key) => [
      expect.stringContaining(`: limits.${key} must be a `),
      { [key]: undefined },
    ]),
    (limits) => load(JSON.stringify({ limits })),
  );
});

test("retention: days are numbers, 0 or more; unlanded_worktree_days is checked first", () => {
  const { dir, file } = setup({});
  const load = (text: string) => {
    writeFileSync(file, text);
    return loadConfig(dir);
  };
  for (const [retention, key] of [
    ['{"unlanded_worktree_days":-1}', "unlanded_worktree_days"],
    ['{"job_log_days":"2"}', "job_log_days"],
    ['{"job_log_days":1e999}', "job_log_days"],
    ['{"job_log_days":-1,"unlanded_worktree_days":-1}', "unlanded_worktree_days"],
  ])
    expect(thrown(() => load(`{"retention":${retention}}`))).toBe(
      `Error: ${file}: retention.${key} must be a number of days (0 or more)`,
    );
  expect(load('{"retention":{"unlanded_worktree_days":0,"job_log_days":2.5}}').retention).toEqual({
    unlanded_worktree_days: 0,
    job_log_days: 2.5,
  });
  expect(thrown(() => load('{"retention":null}'))).toBe(
    `Error: ${file}: retention must be an object`,
  );
});

test("models: roles, then fallback, then variants are checked; every message is exact", () => {
  const { dir, file } = setup({});
  const load = (models: unknown) => {
    writeFileSync(file, JSON.stringify({ models }));
    return loadConfig(dir);
  };
  const message = (models: unknown) => thrown(() => load(models));
  const prefix = `Error: ${file}: models.`;
  const roleMessage = (role: string) =>
    `${prefix}${role} must be a provider/model name, e.g. opencode-go/deepseek-v4.1-flash`;
  for (const role of ["implement", "medium", "hard", "research", "escalation"])
    expect(message({ [role]: "no-slash" })).toBe(roleMessage(role));
  expect(message({ escalation: 1, implement: 1 })).toBe(roleMessage("implement"));
  const roles = ["implement", "medium", "hard", "research", "escalation"];
  expectReportOrder(
    Object.fromEntries([...roles].reverse().map((role) => [role, 1])),
    roles.map((role) => [roleMessage(role), { [role]: undefined }]),
    load,
  );
  expect(message({ implement: "opencode-go/x y" })).toBe(roleMessage("implement"));
  const fallback = `${prefix}fallback must be a list of provider/model names`;
  expect(message({ fallback: "a/b" })).toBe(fallback);
  expect(message({ fallback: ["a/b", "x"] })).toBe(fallback);
  const variants = `${prefix}variants must map provider/model names to an effort, e.g. {"opencode-go/deepseek-v4.1-flash": "high"}`;
  expect(message({ variants: [] })).toBe(variants);
  expect(message({ variants: null })).toBe(variants);
  expect(message({ variants: [], fallback: "x", hard: 1 })).toBe(roleMessage("hard"));
  expect(message({ variants: [], fallback: "x" })).toBe(fallback);
  expect(message(null)).toBe(`Error: ${file}: models must be an object`);
  expect(load({ implement: "a.b-c_d/e:f", fallback: [] }).models).toEqual({
    implement: "a.b-c_d/e:f",
    fallback: [],
  });
});

test("test_cmd and integration_cmd must be non-empty strings", () => {
  const { dir, file } = setup({});
  const message = (config: object) => {
    writeFileSync(file, JSON.stringify(config));
    return thrown(() => loadConfig(dir));
  };
  for (const bad of [" ", 1])
    expect(message({ test_cmd: bad })).toBe(`Error: ${file}: test_cmd must be a non-empty string`);
  for (const bad of [" ", 1, false])
    expect(message({ integration_cmd: bad })).toBe(
      `Error: ${file}: integration_cmd must be a non-empty string`,
    );
});

test("link_dirs: entries are normalized; outside paths and build output are refused, first bad entry first", () => {
  const { dir, file } = setup({});
  const load = (link_dirs: unknown) => {
    writeFileSync(file, JSON.stringify({ link_dirs }));
    return loadConfig(dir);
  };
  const message = (link_dirs: unknown) => thrown(() => load(link_dirs));
  expect(load(["a//b/", "c\\d", "./e", "distx"]).link_dirs).toEqual(["a/b", "c/d", "./e", "distx"]);
  const inside = (entry: string) =>
    `Error: ${file}: link_dirs entry "${entry}" must be a path inside the repository`;
  const build = (entry: string) =>
    `Error: ${file}: link_dirs entry "${entry}" is build output, which is never linked`;
  expect(message(["/abs"])).toBe(inside("/abs"));
  expect(message(["../up"])).toBe(inside("../up"));
  expect(message(["a/../b"])).toBe(inside("a/../b"));
  expect(message(["pkg/build"])).toBe(build("pkg/build"));
  expect(message(["coverage"])).toBe(build("coverage"));
  expect(message(["../x", "dist"])).toBe(inside("../x"));
  expect(message(["dist", "../x"])).toBe(build("dist"));
  for (const bad of [[" "], ["deps", 1], "deps"])
    expect(message(bad)).toBe(`Error: ${file}: link_dirs must be a list of directory paths`);
});

test("local: checks run in a fixed order with exact messages; the entry is normalized", () => {
  const file = emptyHome();
  const load = (local: unknown) => {
    writeFileSync(file, JSON.stringify({ local }));
    return localServer();
  };
  expectReportOrder(
    {
      base_url: "ftp://x",
      model: " ",
      api_key_file: "key.txt",
      api_key_env: "not a name",
      price: { input: -1, output: 1 },
      context: 0,
      output: 1.5,
    },
    (
      [
        [
          "local.base_url must be an http(s) URL, e.g. http://127.0.0.1:8080/v1",
          { base_url: "http://h/v1" },
        ],
        ["local.model must be the server's model id", { model: "m" }],
        ["local.api_key_file must be an absolute path", { api_key_file: "/key" }],
        [
          "local.api_key_env must be an environment variable name, e.g. MY_GATEWAY_KEY",
          { api_key_env: "KEY" },
        ],
        ["local takes api_key_file or api_key_env, not both", { api_key_file: undefined }],
        [
          'local.price must be { "input": <USD per million tokens>, "output": <USD per million tokens> }',
          { price: undefined },
        ],
        ["local.context must be a positive whole number of tokens", { context: undefined }],
        ["local.output must be a positive whole number of tokens", { output: undefined }],
      ] as [string, Record<string, unknown>][]
    ).map(([message, fix]) => [`Error: ${file}: ${message}`, fix]),
    load,
  );
  for (const bad of [[], null, "x"])
    expect(thrown(() => load(bad))).toBe(`Error: ${file}: local must be an object`);
  for (const price of [null, "1", { input: 1, output: "2" }, [1, 2]])
    expect(thrown(() => load({ base_url: "http://h", model: "m", price }))).toMatch(
      /local\.price must be/,
    );
  const server = load({
    extra: 1,
    output: 4096,
    context: 8192,
    price: { input: 0, output: 2, currency: "usd" },
    api_key_env: "KEY",
    model: "  m  ",
    base_url: "http://h/v1///",
  });
  expect(server).toEqual({
    base_url: "http://h/v1",
    model: "m",
    api_key_env: "KEY",
    price: { input: 0, output: 2 },
    context: 8192,
    output: 4096,
  });
  expect(Object.keys(server!)).toEqual([
    "base_url",
    "model",
    "api_key_env",
    "price",
    "context",
    "output",
  ]);
  expect(
    Object.keys(load({ base_url: "http://h", model: "m", api_key_file: "/k", output: 1 })!),
  ).toEqual(["base_url", "model", "api_key_file", "output"]);
});

test("localServer: undefined without a file or an entry; a damaged file throws the parser's error", () => {
  const file = emptyHome();
  expect(localServer()).toBeUndefined();
  writeFileSync(file, "{}");
  expect(localServer()).toBeUndefined();
  writeFileSync(file, "null");
  expect(localServer()).toBeUndefined();
  writeFileSync(file, "{ not json");
  expect(thrown(() => localServer())).toMatch(/^SyntaxError: /);
});

test("ollama: checks run in a fixed order with exact messages; defaults depend on the endpoint", () => {
  const file = emptyHome();
  const load = (ollama: unknown) => {
    writeFileSync(file, JSON.stringify({ ollama }));
    return ollamaConfig();
  };
  const message = (ollama: unknown) => thrown(() => load(ollama));
  const prefix = `Error: ${file}: ollama`;
  expect(message([])).toBe(`${prefix} must be an object`);
  expect(message(null)).toBe(`${prefix} must be an object`);
  expect(message({ endpoint: "remote" })).toBe(`${prefix}.endpoint must be "local" or "cloud"`);
  expect(message({ endpoint: "local", base_url: "ftp://x" })).toBe(
    `${prefix}.base_url must be an http(s) URL, e.g. ${OLLAMA_LOCAL_URL}`,
  );
  expect(message({ endpoint: "cloud", base_url: 1 })).toBe(
    `${prefix}.base_url must be an http(s) URL, e.g. ${OLLAMA_CLOUD_URL}`,
  );
  expect(message({ endpoint: "cloud", base_url: "http://8.8.8.8/v1", model: 1 })).toBe(
    `${prefix}.base_url with plain http must be this machine or a private network; use https`,
  );
  expect(message({ endpoint: "local", model: " ", api_key_env: "bad name" })).toBe(
    `${prefix}.model must be the local server's model id, e.g. "llama3.2"`,
  );
  expect(message({ endpoint: "cloud", model: " ", api_key_env: "bad name" })).toBe(
    `${prefix}.model must be a model id`,
  );
  expect(message({ endpoint: "cloud", api_key_env: "bad name", price: 1 })).toBe(
    `${prefix}.api_key_env must be an environment variable name, e.g. OLLAMA_API_KEY`,
  );
  expect(message({ endpoint: "local", model: "m", api_key_env: 1 })).toBe(
    `${prefix}.api_key_env must be an environment variable name, e.g. OLLAMA_API_KEY`,
  );
  expect(message({ endpoint: "cloud", price: 1, context: 0 })).toBe(
    `${prefix}.price must be { "input": <USD per million tokens>, "output": <USD per million tokens> }`,
  );
  expect(message({ endpoint: "cloud", context: 0, output: 0 })).toBe(
    `${prefix}.context must be a positive whole number of tokens`,
  );
  expect(message({ endpoint: "cloud", output: "1" })).toBe(
    `${prefix}.output must be a positive whole number of tokens`,
  );

  const local = load({
    output: 1,
    model: " llama3.2 ",
    base_url: "http://box.lan:11434/v1/",
    endpoint: "local",
  });
  expect(local).toEqual({
    endpoint: "local",
    base_url: "http://box.lan:11434/v1",
    model: "llama3.2",
    output: 1,
  });
  expect(Object.keys(local!)).toEqual(["endpoint", "base_url", "model", "output"]);
  expect(load({ endpoint: "local", model: "m", api_key_env: "KEY" })).toEqual({
    endpoint: "local",
    base_url: OLLAMA_LOCAL_URL,
    model: "m",
    api_key_env: "KEY",
  });
  const cloud = load({
    endpoint: "cloud",
    model: "glm",
    base_url: "https://gateway.example.com/v1",
    api_key_env: "MY_KEY",
    price: { input: 1, output: 2 },
    context: 5,
  });
  expect(Object.keys(cloud!)).toEqual([
    "endpoint",
    "base_url",
    "model",
    "api_key_env",
    "price",
    "context",
  ]);
  expect(cloud).toMatchObject({ model: "glm", api_key_env: "MY_KEY" });
});

test("ollamaConfig, ollamaEndpoint and ollamaIsLocal: the configured entry, else the key alone, else nothing", () => {
  const file = emptyHome();
  expect(ollamaConfig()).toBeUndefined();
  expect(ollamaEndpoint()).toBeUndefined();
  expect(ollamaIsLocal()).toBe(false);
  vi.stubEnv("OLLAMA_API_KEY", "key");
  expect(ollamaConfig()).toBeUndefined();
  expect(ollamaEndpoint()).toEqual({
    endpoint: "cloud",
    base_url: OLLAMA_CLOUD_URL,
    api_key_env: "OLLAMA_API_KEY",
  });
  expect(ollamaIsLocal()).toBe(false);
  writeFileSync(file, JSON.stringify({ ollama: { endpoint: "local", model: "m" } }));
  expect(ollamaEndpoint()).toEqual({ endpoint: "local", base_url: OLLAMA_LOCAL_URL, model: "m" });
  expect(ollamaIsLocal()).toBe(true);
  writeFileSync(file, JSON.stringify({ ollama: { endpoint: "local" } }));
  expect(thrown(() => ollamaEndpoint())).toBe(
    `Error: ${file}: ollama.model must be the local server's model id, e.g. "llama3.2"`,
  );
  expect(ollamaIsLocal()).toBe(false);
  writeFileSync(file, "null");
  expect(ollamaConfig()).toBeUndefined();
  writeFileSync(file, "{ not json");
  expect(thrown(() => ollamaConfig())).toMatch(/^SyntaxError: /);
  expect(ollamaIsLocal()).toBe(false);
});

test("chosenProvider: the user config's provider string, else undefined, even for a damaged file", () => {
  const file = emptyHome();
  expect(chosenProvider()).toBeUndefined();
  writeFileSync(file, JSON.stringify({ provider: "deepseek" }));
  expect(chosenProvider()).toBe("deepseek");
  writeFileSync(file, JSON.stringify({ provider: 1 }));
  expect(chosenProvider()).toBeUndefined();
  writeFileSync(file, "null");
  expect(chosenProvider()).toBeUndefined();
  writeFileSync(file, "{ not json");
  expect(chosenProvider()).toBeUndefined();
});

test("userConfigFile: under XDG_CONFIG_HOME, or ~/.config when it is empty", () => {
  vi.stubEnv("XDG_CONFIG_HOME", "/somewhere");
  vi.stubEnv("HOME", "/home/someone");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  expect(userConfigFile()).toBe(join("/somewhere", "cheapag", "config.json"));
  vi.stubEnv("XDG_CONFIG_HOME", "");
  expect(userConfigFile()).toBe(join("/home/someone", ".config", "cheapag", "config.json"));
});

test("addAllowCommand writes the repo's cheapag.json: creates it, appends once, keeps other keys and their order", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const file = join(repo.dir, "cheapag.json");
  const text = () => readFileSync(file, "utf8");
  addAllowCommand(repo.dir, "make test");
  expect(text()).toBe('{\n  "allow_commands": [\n    "make test"\n  ]\n}\n');
  writeFileSync(file, '{"test_cmd":"x","allow_commands":["a"],"guard_lines":3}');
  addAllowCommand(repo.dir, "b");
  expect(text()).toBe(
    '{\n  "test_cmd": "x",\n  "allow_commands": [\n    "a",\n    "b"\n  ],\n  "guard_lines": 3\n}\n',
  );
  writeFileSync(file, '{"allow_commands":["a"]}');
  addAllowCommand(repo.dir, "a");
  expect(text()).toBe('{\n  "allow_commands": [\n    "a"\n  ]\n}\n');
  writeFileSync(file, '{"allow_commands":"a"}');
  addAllowCommand(repo.dir, "b");
  expect(text()).toBe('{\n  "allow_commands": [\n    "b"\n  ]\n}\n');
  writeFileSync(file, "{ not json");
  expect(thrown(() => addAllowCommand(repo.dir, "b"))).toMatch(/^SyntaxError: /);
  expect(text()).toBe("{ not json");
});

test("privateHost: more hosts, as the URL parser normalizes them", () => {
  for (const url of [
    "http://0x7f.1",
    "http://LOCALHOST:1",
    "http://foo.localhost",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://169.254.1.1",
    "http://172.31.255.255",
    "http://my.home.arpa",
    "http://x.internal",
    "http://home",
    "file:///x",
  ])
    expect(privateHost(url), url).toBe(true);
  for (const url of [
    "http://[2001:db8::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://172.15.0.1",
    "http://100.63.0.1",
    "http://1.2.3",
    "http://1.2.3.4.5",
    "http://10.0.0.256",
    "https://ollama.com",
  ])
    expect(privateHost(url), url).toBe(false);
});
