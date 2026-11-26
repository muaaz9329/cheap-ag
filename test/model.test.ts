import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { select } from "../src/prompt.js";
import { startFakeOpencode } from "./fake-opencode.js";
import * as prompt from "../src/prompt.js";
import { model } from "../src/model.js";
import { stopOpencode } from "../src/opencode.js";
import { hermeticHome, homeEnv, serverEntry, tempRepo, type Logins } from "./harness.js";

/** Runs the real `cheapag model <args>` against the fake OpenCode; async because the fake lives in this process. */
async function run(...args: string[]) {
  return runAs({ "opencode-go": "k" }, ...args);
}

/** The same with other saved logins. */
async function runAs(logins: Logins, ...args: string[]) {
  return runWith({ logins }, ...args);
}

type FakeProviders = NonNullable<Parameters<typeof startFakeOpencode>[0]>["providers"];

/** The same with a custom catalog, a user config written first, or another working directory; also returns the exit code. */
async function runWith(
  opts: { logins?: Logins; providers?: FakeProviders; userConfig?: unknown; cwd?: string },
  ...args: string[]
) {
  const fake = await startFakeOpencode({ providers: opts.providers });
  const { home, env } = hermeticHome(opts.logins ?? { "opencode-go": "k" });
  onTestFinished(async () => {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  const configFile = join(home, "config", "cheapag", "config.json");
  if (opts.userConfig !== undefined) {
    mkdirSync(join(home, "config", "cheapag"), { recursive: true });
    writeFileSync(configFile, JSON.stringify(opts.userConfig));
  }
  const exec = promisify(execFile)(process.execPath, [serverEntry, "model", ...args], {
    cwd: opts.cwd ?? home,
    env: { ...env, CHEAPAG_OPENCODE_URL: fake.url },
  });
  const result = await exec.catch((e) => e);
  return {
    stdout: result.stdout as string,
    code: (result as { code?: number }).code ?? 0,
    configFile,
    config: () => readFileSync(configFile, "utf8"),
  };
}

test("--list prints the current models, the suggestions, and ends with the line about more models", async () => {
  const { stdout } = await run("--list");
  const lines = stdout.trim().split("\n");
  expect(lines.slice(0, 4)).toEqual([
    "Provider: OpenCode Go",
    "Main: deepseek-v4.1-flash (effort default)",
    "Fallback: qwen3.7-plus (effort default)",
    "Suggestions:",
  ]);
  expect(lines.slice(4)).toEqual([
    "small-flash · $0.14/$0.28 per M · 128K ctx · efforts: none",
    "big-reasoner · $0.9/$2.7 per M · 256K ctx · efforts: high, max",
    "For more models, exit Claude/Codex and run: npx cheap-agent model",
  ]);
});

test("--main with a valid id and effort saves the user config", async () => {
  const { stdout, config } = await run(
    "--main",
    "opencode-go/big-reasoner",
    "--effort",
    "max",
    "--fallback",
    "small-flash",
  );
  expect(stdout).toMatch(
    /^✓ main opencode-go\/big-reasoner \(effort max\), fallback opencode-go\/small-flash \(effort default\) — saved in .*; the next job uses it\n$/,
  );
  expect(JSON.parse(config()).models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: ["opencode-go/small-flash"],
    variants: { "opencode-go/big-reasoner": "max" },
  });
});

test("an unknown id, a chat-only model and a wrong effort are refused", async () => {
  expect((await run("--main", "nope")).stdout).toBe(
    "✗ nope is not a tool-calling model on OpenCode Go; run npx cheap-agent model --list\n",
  );
  expect((await run("--main", "chat-only")).stdout).toContain(
    "chat-only is not a tool-calling model",
  );
  expect((await run("--main", "small-flash", "--effort", "high")).stdout).toBe(
    "✗ small-flash has no effort high; it has: none\n",
  );
  expect((await run("--main", "big-reasoner", "--effort", "low")).stdout).toBe(
    "✗ big-reasoner has no effort low; it has: high, max\n",
  );
});

/** A fake terminal: `select` reads these keys and writes its drawing to the sink. */
function drive(keys: string) {
  const input = Object.assign(new PassThrough(), { setRawMode: vi.fn(), isTTY: true }) as any;
  const output = Object.assign(new PassThrough(), { columns: 80 }) as any;
  const options = [{ label: "a" }, { label: "b", hint: "hint" }, { label: "c" }];
  const picked = select("Pick:", options, 0, { input, output });
  setImmediate(() => input.write(keys));
  return { picked, input };
}

test("select: arrows and Enter, Enter alone, a number jumps, and the terminal is restored", async () => {
  const down = drive("\x1b[B\x1b[B\r");
  expect(await down.picked).toBe(2);
  expect(down.input.setRawMode).toHaveBeenLastCalledWith(false);
  expect(await drive("\r").picked).toBe(0);
  expect(await drive("2\r").picked).toBe(1);
});

test("select: Ctrl-C restores the terminal and exits 130", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  onTestFinished(() => {
    exit.mockRestore();
  });
  const { input } = drive("\x03");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
  expect(input.setRawMode).toHaveBeenLastCalledWith(false);
});

test("an unknown or incomplete argument prints it with the usage; a catalog error is printed and exits 1", async () => {
  const usage =
    "usage: cheapag model [--list | --main <id> [--effort <e>] [--fallback <id|none>] [--fallback-effort <e>]]\n";
  expect((await run("--bogus")).stdout).toBe(`✗ unknown or incomplete argument --bogus\n${usage}`);
  expect((await run("--main")).stdout).toBe(`✗ unknown or incomplete argument --main\n${usage}`);
  // the fake's catalog only lists OpenCode Go
  expect((await runAs({ deepseek: "k" }, "--list")).stdout).toBe(
    "✗ OpenCode lists no models for deepseek\n",
  );
});

/** `cheapag model` in this process on a terminal, with the picker answering `answers` in order; returns what it printed and each question asked. */
async function pickInteractively(
  answers: number[],
  opts: {
    logins?: Logins;
    providers?: Parameters<typeof startFakeOpencode>[0] extends infer O
      ? O extends { providers?: infer P }
        ? P
        : never
      : never;
    cwd?: string;
    userConfig?: unknown;
  } = {},
) {
  const fake = await startFakeOpencode({ providers: opts.providers });
  const { home } = hermeticHome(opts.logins ?? { "opencode-go": "k" });
  const file = join(home, "config", "cheapag", "config.json");
  if (opts.userConfig !== undefined) {
    mkdirSync(join(home, "config", "cheapag"), { recursive: true });
    writeFileSync(file, JSON.stringify(opts.userConfig));
  }
  for (const [key, value] of Object.entries(homeEnv(home)))
    if (key.startsWith("XDG_")) vi.stubEnv(key, value);
  vi.stubEnv("CHEAPAG_OPENCODE_URL", fake.url);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(opts.cwd ?? home);
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const questions: { question: string; options: string[]; initial: number }[] = [];
  const hints: (string | undefined)[][] = [];
  const select = vi
    .spyOn(prompt, "select")
    .mockImplementation(async (question, options, initial = 0) => {
      questions.push({ question, options: options.map((o) => o.label), initial });
      hints.push(options.map((o) => o.hint));
      return answers.shift()!;
    });
  let printed = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => ((printed += chunk), true));
  onTestFinished(async () => {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    stopOpencode();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  const code = await model([]);
  stdout.mockRestore();
  select.mockRestore();
  cwd.mockRestore();
  return {
    code,
    printed,
    questions,
    hints,
    file,
    config: () => JSON.parse(readFileSync(file, "utf8")),
  };
}

test("on a terminal the picker asks main, its effort, and the fallback (no effort question for a model without efforts), then saves", async () => {
  // catalog order is cheapest first: small-flash, big-reasoner
  const r = await pickInteractively([1, 2, 1]);
  expect(r.code).toBe(0);
  expect(r.questions).toEqual([
    {
      question: "Main model on OpenCode Go (writes the code):",
      options: ["small-flash", "big-reasoner"],
      initial: 0,
    },
    { question: "Effort for main big-reasoner:", options: ["default", "high", "max"], initial: 0 },
    {
      question: "Fallback model (used on a rate limit):",
      options: ["none", "small-flash", "big-reasoner"],
      initial: 0,
    },
  ]);
  expect(r.printed).toMatch(
    /^✓ main opencode-go\/big-reasoner \(effort max\), fallback opencode-go\/small-flash \(effort default\) — saved in .*; the next job uses it\n$/,
  );
  expect(r.config().models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: ["opencode-go/small-flash"],
    variants: { "opencode-go/big-reasoner": "max" },
  });
});

test("the picker's default effort and no fallback save neither", async () => {
  const r = await pickInteractively([1, 0, 0]);
  expect(r.printed).toMatch(/^✓ main opencode-go\/big-reasoner \(effort default\), fallback none /);
  expect(r.config().models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: [],
  });
});

test("on OpenRouter a pick inside a repo with consent re-accepts the route, so the new model needs no second approval", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const consentFile = join(repo.dir, ".cheapag", "consent.json");
  const providers = [
    {
      id: "openrouter",
      models: [
        { id: "acme/coder", name: "Coder", toolcall: true, input: 1, output: 2, context: 100_000 },
      ],
    },
  ];
  expect(
    (await pickInteractively([0, 0], { logins: { openrouter: "k" }, providers, cwd: repo.dir }))
      .code,
  ).toBe(0);
  expect(existsSync(consentFile)).toBe(false); // no consent yet: picking a model never creates one
  mkdirSync(join(repo.dir, ".cheapag"), { recursive: true });
  writeFileSync(
    consentFile,
    JSON.stringify({
      mode: "all",
      provider: "openrouter",
      route: ["openrouter/old/model"],
      approvedAt: "2026-11-01T00:00:00Z",
    }),
  );
  expect(
    (await pickInteractively([0, 0], { logins: { openrouter: "k" }, providers, cwd: repo.dir }))
      .code,
  ).toBe(0);
  const consent = JSON.parse(readFileSync(consentFile, "utf8"));
  expect(consent).toMatchObject({
    mode: "all",
    provider: "openrouter",
    approvedAt: "2026-11-01T00:00:00Z",
  });
  expect(consent.route).toContain("openrouter/acme/coder");
  expect(consent.route).not.toContain("openrouter/old/model");
});

const USAGE =
  "usage: cheapag model [--list | --main <id> [--effort <e>] [--fallback <id|none>] [--fallback-effort <e>]]";

/** The default fake catalog as `cheapag model` prints it off a terminal, without the usage line. */
const DESCRIBED = [
  "Provider: OpenCode Go",
  "Main: deepseek-v4.1-flash (effort default)",
  "Fallback: qwen3.7-plus (effort default)",
  "Suggestions:",
  "small-flash · $0.14/$0.28 per M · 128K ctx · efforts: none",
  "big-reasoner · $0.9/$2.7 per M · 256K ctx · efforts: high, max",
  "For more models, exit Claude/Codex and run: npx cheap-agent model",
].join("\n");

test("off a terminal, no flags print the current models and suggestions, then the usage, and exit 0", async () => {
  const r = await run();
  expect(r.stdout).toBe(`${DESCRIBED}\n${USAGE}\n`);
  expect(r.code).toBe(0);
});

test("exit codes: --list and a save exit 0; a refused id, a bad argument and a catalog error exit 1", async () => {
  expect((await run("--list")).code).toBe(0);
  expect((await run("--main", "small-flash")).code).toBe(0);
  expect((await run("--main", "nope")).code).toBe(1);
  expect((await run("--bogus")).code).toBe(1);
  expect((await runAs({ deepseek: "k" }, "--list")).code).toBe(1);
});

test("with no saved login it says to log in first and exits 1", async () => {
  const r = await runAs({}, "--list");
  expect(r.stdout).toBe("✗ no worker provider; run npx cheap-agent login first\n");
  expect(r.code).toBe(1);
});

test("--effort, --fallback or --fallback-effort without --main print the usage and exit 1; an empty --effort counts as unset", async () => {
  for (const args of [
    ["--effort", "max"],
    ["--fallback", "small-flash"],
    ["--fallback-effort", "high"],
  ]) {
    const r = await run(...args);
    expect(r.stdout).toBe(`✗ --effort, --fallback and --fallback-effort need --main\n${USAGE}\n`);
    expect(r.code).toBe(1);
  }
  expect((await run("--effort", "")).stdout).toBe(`${DESCRIBED}\n${USAGE}\n`);
});

test("known bug, pinned: a flag named like an Object.prototype key takes the next argument instead of being refused", async () => {
  const r = await run("constructor", "x");
  expect(r.stdout).toBe(`${DESCRIBED}\n${USAGE}\n`);
  expect(r.code).toBe(0);
});

test("--fallback none saves no fallback and prints the exact config path", async () => {
  const r = await run("--main", "small-flash", "--fallback", "none");
  expect(r.stdout).toBe(
    `✓ main opencode-go/small-flash (effort default), fallback none — saved in ${r.configFile}; the next job uses it\n`,
  );
  expect(r.code).toBe(0);
  expect(JSON.parse(r.config()).models).toEqual({
    implement: "opencode-go/small-flash",
    research: "opencode-go/small-flash",
    fallback: [],
  });
});

test("--main wins over --list", async () => {
  const r = await run("--list", "--main", "small-flash");
  expect(r.stdout).toMatch(/^✓ main opencode-go\/small-flash \(effort default\), fallback none /);
  expect(r.code).toBe(0);
});

test("a fallback with its own effort is checked and saved with it", async () => {
  const r = await run(
    "--main",
    "small-flash",
    "--fallback",
    "opencode-go/big-reasoner",
    "--fallback-effort",
    "high",
  );
  expect(r.stdout).toBe(
    `✓ main opencode-go/small-flash (effort default), fallback opencode-go/big-reasoner (effort high) — saved in ${r.configFile}; the next job uses it\n`,
  );
  expect(JSON.parse(r.config()).models).toEqual({
    implement: "opencode-go/small-flash",
    research: "opencode-go/small-flash",
    fallback: ["opencode-go/big-reasoner"],
    variants: { "opencode-go/big-reasoner": "high" },
  });
});

test("a bad fallback is refused and nothing is saved; a bad main and a bad fallback are both reported, main first", async () => {
  const refusals: [string[], string][] = [
    [
      ["--main", "small-flash", "--fallback-effort", "high"],
      "✗ --fallback-effort needs --fallback <id>\n",
    ],
    [
      ["--main", "small-flash", "--fallback", "none", "--fallback-effort", "high"],
      "✗ --fallback-effort needs --fallback <id>\n",
    ],
    [
      ["--main", "small-flash", "--fallback", "nope"],
      "✗ nope is not a tool-calling model on OpenCode Go; run npx cheap-agent model --list\n",
    ],
    [
      ["--main", "small-flash", "--fallback", "big-reasoner", "--fallback-effort", "low"],
      "✗ big-reasoner has no effort low; it has: high, max\n",
    ],
    [
      ["--main", "bad-main", "--fallback", "bad-fallback"],
      "✗ bad-main is not a tool-calling model on OpenCode Go; run npx cheap-agent model --list\n" +
        "✗ bad-fallback is not a tool-calling model on OpenCode Go; run npx cheap-agent model --list\n",
    ],
  ];
  for (const [args, printed] of refusals) {
    const r = await run(...args);
    expect(r.stdout).toBe(printed);
    expect(r.code).toBe(1);
    expect(existsSync(r.configFile)).toBe(false);
  }
});

/** A catalog that exercises the suggestions: a free promo, an output-only price, cheap models, and the routed ones. */
const WIDE_CATALOG = [
  {
    id: "opencode-go",
    models: [
      { id: "free-promo", name: "Free", toolcall: true, input: 0, output: 0, context: 0 },
      { id: "half-free", name: "Half", toolcall: true, input: 0, output: 0.5, context: 32_768 },
      { id: "cheap-a", name: "A", toolcall: true, input: 0.01, output: 0.02, context: 64_000 },
      { id: "cheap-b", name: "B", toolcall: true, input: 0.02, output: 0.04, context: 64_000 },
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek",
        toolcall: true,
        input: 0.3,
        output: 0.6,
        context: 1_048_576,
        variants: ["high"],
      },
      { id: "glm-5.3", name: "GLM", toolcall: true, input: 1, output: 3, context: 200_000 },
      { id: "kimi-k3", name: "Kimi", toolcall: true, input: 2, output: 4, context: 262_144 },
    ],
  },
];

test("suggestions: the current main, then routed models, then the cheapest paid ones, at most 4, free ones left out", async () => {
  const r = await runWith({ providers: WIDE_CATALOG }, "--list");
  expect(r.stdout).toBe(
    [
      "Provider: OpenCode Go",
      "Main: deepseek-v4.1-flash (effort default)",
      "Fallback: qwen3.7-plus (effort default)",
      "Suggestions:",
      "deepseek-v4.1-flash · $0.3/$0.6 per M · 1049K ctx · efforts: high",
      "glm-5.3 · $1/$3 per M · 200K ctx · efforts: none",
      "kimi-k3 · $2/$4 per M · 262K ctx · efforts: none",
      "half-free · $0/$0.5 per M · 33K ctx · efforts: none",
      "For more models, exit Claude/Codex and run: npx cheap-agent model",
      "",
    ].join("\n"),
  );
  expect(r.code).toBe(0);
});

test("a free current main with no context is shown with no price and ctx unknown, with its effort and no fallback", async () => {
  const userConfig = {
    models: {
      implement: "opencode-go/free-promo",
      fallback: [],
      variants: { "opencode-go/free-promo": "high" },
    },
  };
  const r = await runWith({ providers: WIDE_CATALOG, userConfig }, "--list");
  expect(r.stdout).toBe(
    [
      "Provider: OpenCode Go",
      "Main: free-promo (effort high)",
      "Fallback: none (effort default)",
      "Suggestions:",
      "free-promo · no price · ctx unknown · efforts: none",
      "deepseek-v4.1-flash · $0.3/$0.6 per M · 1049K ctx · efforts: high",
      "glm-5.3 · $1/$3 per M · 200K ctx · efforts: none",
      "kimi-k3 · $2/$4 per M · 262K ctx · efforts: none",
      "For more models, exit Claude/Codex and run: npx cheap-agent model",
      "",
    ].join("\n"),
  );
});

test("inside a repo, models naming another provider are warned about after the suggestions and before the usage", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  writeFileSync(
    join(repo.dir, "cheapag.json"),
    JSON.stringify({
      models: { research: "openrouter/acme/coder", fallback: ["deepseek/deepseek-flash"] },
    }),
  );
  const r = await runWith({ cwd: repo.dir });
  expect(r.stdout).toBe(
    [
      "Provider: OpenCode Go",
      "Main: deepseek-v4.1-flash (effort default)",
      "Fallback: none (effort default)",
      "Suggestions:",
      "small-flash · $0.14/$0.28 per M · 128K ctx · efforts: none",
      "big-reasoner · $0.9/$2.7 per M · 256K ctx · efforts: high, max",
      "For more models, exit Claude/Codex and run: npx cheap-agent model",
      "! models.research names openrouter/acme/coder, which is not a model on OpenCode Go; it is ignored and the worker runs opencode-go/deepseek-v4.1-flash. Fix it in cheapag.json or run npx cheap-agent model",
      "! models.fallback names deepseek/deepseek-flash, which is not a model on OpenCode Go; it is ignored and the worker runs opencode-go/deepseek-v4.1-flash. Fix it in cheapag.json or run npx cheap-agent model",
      USAGE,
      "",
    ].join("\n"),
  );
  expect(r.code).toBe(0);
});

test("the picker preselects the current main and its effort, never the fallback or its effort, and shows each row's price, context and efforts", async () => {
  const r = await pickInteractively([1, 1, 2, 2], {
    userConfig: {
      models: {
        implement: "opencode-go/big-reasoner",
        fallback: ["opencode-go/big-reasoner"],
        variants: { "opencode-go/big-reasoner": "max" },
      },
    },
  });
  expect(r.code).toBe(0);
  expect(r.questions).toEqual([
    {
      question: "Main model on OpenCode Go (writes the code):",
      options: ["small-flash", "big-reasoner"],
      initial: 1,
    },
    { question: "Effort for main big-reasoner:", options: ["default", "high", "max"], initial: 2 },
    {
      question: "Fallback model (used on a rate limit):",
      options: ["none", "small-flash", "big-reasoner"],
      initial: 0,
    },
    {
      question: "Effort for fallback big-reasoner:",
      options: ["default", "high", "max"],
      initial: 0,
    },
  ]);
  const rows = [
    "$0.14/$0.28 per M · 128K ctx · efforts: none",
    "$0.9/$2.7 per M · 256K ctx · efforts: high, max",
  ];
  expect(r.hints).toEqual([
    rows,
    [undefined, undefined, undefined],
    [undefined, ...rows],
    [undefined, undefined, undefined],
  ]);
  expect(r.printed).toBe(
    `✓ main opencode-go/big-reasoner (effort high), fallback opencode-go/big-reasoner (effort max) — saved in ${r.file}; the next job uses it\n`,
  );
  expect(r.config().models).toEqual({
    implement: "opencode-go/big-reasoner",
    research: "opencode-go/big-reasoner",
    fallback: ["opencode-go/big-reasoner"],
    variants: { "opencode-go/big-reasoner": "max" },
  });
});

test("on OpenRouter a pick outside any repo still saves and exits 0", async () => {
  const providers = [
    {
      id: "openrouter",
      models: [
        { id: "acme/coder", name: "Coder", toolcall: true, input: 1, output: 2, context: 100_000 },
      ],
    },
  ];
  const r = await pickInteractively([0, 0], { logins: { openrouter: "k" }, providers });
  expect(r.code).toBe(0);
  expect(r.printed).toBe(
    `✓ main openrouter/acme/coder (effort default), fallback none — saved in ${r.file}; the next job uses it\n`,
  );
});
