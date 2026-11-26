import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { afterAll, beforeAll, expect, test } from "vitest";
import { opencodeBinary, SECRETS_PLUGIN } from "../src/opencode.js";
import {
  baselinePermission,
  canAlwaysAllow,
  commandPrefix,
  HARD_DENY,
  isHardDenied,
  projectScripts,
  PROTECTED,
  rejectionMessage,
  researchRuleset,
  workerRuleset,
  WRITE_OR_RUN,
} from "../src/permissions.js";
import { checkAllows } from "../src/verify.js";
import { gitBash, killProcessGroup, link } from "../src/platform.js";
import { startFakeLlm, type Reply } from "./fake-llm.js";
import { hermeticHome, slow, tempRepo } from "./harness.js";

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
  link(deps, join(repo.dir, "node_modules")); // as createWorktree links it
  writeFileSync(
    join(repo.dir, "package.json"),
    JSON.stringify({ scripts: { lint: "echo linted > lint.out", "*": "echo wildcard name" } }),
  );
  writeFileSync(join(repo.dir, "Makefile"), "check:\n\techo made > make.out\n");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo.dir, "a"), "a\n");
  writeFileSync(join(repo.dir, "b"), "b\n");
  writeFileSync(join(repo.dir, ".env"), "SECRET=0\n");
  const { home, env } = hermeticHome({ openrouter: "sk-or-v1-fakefakefakefakefakefake" });
  const config = join(home, "oc");
  mkdirSync(join(config, "agents"), { recursive: true });
  writeFileSync(
    join(config, "opencode.json"),
    JSON.stringify({
      small_model: "openrouter/m",
      provider: { openrouter: { options: { baseURL: llm.url }, models: { m: {} } } },
    }),
  );
  mkdirSync(join(config, "plugins"));
  writeFileSync(join(config, "plugins", "cheapag-secrets.js"), SECRETS_PLUGIN);
  writeFileSync(
    join(config, "agents", "cheapag-worker.md"),
    "---\ndescription: worker\nmode: primary\n---\nYou implement plan steps.\n",
  );
  const oc = spawn(opencodeBinary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    detached: true,
    env: {
      ...env,
      ...(gitBash() && { SHELL: gitBash() }),
      OPENCODE_SERVER_PASSWORD: "t",
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PERMISSION: JSON.stringify(baselinePermission()),
    },
  });
  oc.stderr.resume(); // never let a full pipe stall the server
  stop = () => killProcessGroup(oc.pid, "SIGKILL");
  process.once("exit", stop); // an interrupted run must not orphan the server's process group
  const url = await new Promise<string>((resolve, reject) => {
    oc.stdout.on(
      "data",
      (d) => String(d).match(/(http:\/\/\S+)/) && resolve(String(d).match(/(http:\/\/\S+)/)![1]),
    );
    oc.on("exit", (code) => reject(new Error(`opencode exited ${code}`)));
  });
  client = createOpencodeClient({
    baseUrl: url,
    directory: repo.dir,
    headers: { authorization: `Basic ${Buffer.from("opencode:t").toString("base64")}` },
  });
  const t = Date.now();
  await bash("git status");
  console.error(
    `cheapag-test: first worker bash call took ${Date.now() - t} ms (${process.platform})`,
  );
}, slow(180_000));

afterAll(async () => {
  stop?.();
  await llm?.close();
  repo?.cleanup();
  rmSync(deps, { recursive: true, force: true });
});

/** One model step calling `tool` under Cheap Agent's ruleset for this repo; resolves to the tool's outcome. */
async function call(
  tool: string,
  args: Record<string, unknown>,
  extraExact: string[] = [],
  onBlockedCommand: "ask" | "deny" = "deny",
) {
  llm.script({ tool, args } as Reply);
  const { scripts, exact } = projectScripts(repo.dir);
  const permission = workerRuleset({
    scripts,
    exact: [...exact, "node check.mjs", ...extraExact],
    allowCommands: ["echo allowed-by-config"],
    linked: ["node_modules"],
    onBlockedCommand,
  });
  const session = (
    await client.session.create({
      directory: repo.dir,
      agent: "cheapag-worker",
      model: { providerID: "openrouter", id: "m" },
      permission,
    })
  ).data!;
  const { stream } = await client.event.subscribe({ directory: repo.dir });
  await stream.next();
  await client.session.promptAsync({
    sessionID: session.id,
    directory: repo.dir,
    parts: [{ type: "text", text: "go" }],
  });
  let outcome = "no tool call";
  for await (const raw of stream) {
    const e = raw as Event;
    if ((e.properties as { sessionID?: string }).sessionID !== session.id) continue;
    if (e.type === "permission.asked") {
      await client.permission.reply({
        requestID: e.properties.id,
        reply: "reject",
        message: "test",
      }); // never leave it blocked
      outcome = `asked:${e.properties.permission}`; // keep reading to idle: a stale session would take the next test's scripted reply
      continue;
    }
    if (e.type === "message.part.updated" && e.properties.part.type === "tool") {
      const state = e.properties.part.state;
      if (state.status === "completed") outcome = "allowed";
      if (state.status === "error" && outcome.startsWith("asked:")) continue;
      if (state.status === "error")
        outcome = /rule which prevents/.test(state.error)
          ? "denied"
          : /unavailable tool/.test(state.error)
            ? "unavailable"
            : `error: ${state.error}`;
    }
    if (e.type === "session.idle") break;
  }
  return outcome;
}

const bash = (command: string, mode: "ask" | "deny" = "deny") =>
  call("bash", { command, description: "test" }, [], mode);
const write = (path: string) =>
  call("write", { filePath: path.startsWith("/") ? path : join(repo.dir, path), content: "x\n" });

test.each([
  "npm install zod",
  "npm i zod",
  "pnpm add zod",
  "yarn add zod",
  "pip install requests",
  "go get example.com/x",
  "cargo add serde",
  "brew install jq",
  "git commit -m x",
  "git push",
  "git reset --hard",
  "git checkout main",
  "git stash",
  "git clean -fd",
  "rm -rf src",
  "sudo ls",
  "curl https://example.com",
  "wget https://example.com",
  "ssh host",
  "scp a b",
  "npm publish",
  "chmod -R 777 .",
  "cat /etc/passwd",
  "npm run lint && curl https://example.com",
  // probes from review: chains, substitution, redirection, spacing, aliases, flags on allowed commands
  "npm run lint; curl https://example.com",
  "npm run lint | sh",
  "npm run lint $(curl https://example.com)",
  "npm run lint `curl https://example.com`",
  "git status > .env",
  "npm run lint > yarn.lock",
  "npm  install zod",
  "npm in zod",
  "npm isntall zod",
  "npm --global install zod",
  "git diff --output=.env",
  "git log --output=package-lock.json",
  "git difftool -y -x 'npm install zod' HEAD",
  "git -c alias.x=commit x",
  "git statusx",
  "go test -exec 'sh -c curl' ./...",
  "make -f evil.mk",
  "make check -f evil.mk",
  "rm -r -f src",
  "rm -Rf src",
  "npm exec cowsay",
  "pnpm dlx cowsay",
  "bunx cowsay",
  "yarn dlx cowsay",
  "node check.mjs --eval 'x'",
  "node -e 1",
  "npx cowsay hi",
  "npx --yes cowsay hi",
  "cat .env",
  "head -1 config/.env.local",
  "rg --no-ignore KEY .",
  "rg -uu KEY .",
  "grep -r KEY .",
  // writes stay refused even when the same command suppresses stderr; find is allowed only for reading
  "cat a > b",
  "cat a > b 2>/dev/null",
  "echo x >> f",
  "sed -n 1,40p f",
  "find . -delete",
  "find . -exec rm {} \\;",
  "cat .env 2>/dev/null",
  "git branch -D x",
  "node x.js 2>/dev/null",
])(
  "bash `%s` is denied",
  async (command) => {
    expect(await bash(command)).toBe("denied");
  },
  slow(30_000),
);

// ticket 69: with on_blocked_command "ask" the catch-all is an ask, but HARD_DENY commands stay a hard deny
test.each([
  "npm run lint | sh",
  "npm run lint |sh",
  "npm run lint | bash",
  "npm run lint | zsh -s",
  "npm run lint $(curl https://example.com)",
  "npm run lint `curl https://example.com`",
  "npm  install zod",
  "npm --global install zod",
  "npm in zod",
  "pnpm  add zod",
  "bash -c 'npm run lint'",
  "curl x",
  "cat a > b",
  "rm -Rf src",
  "git push",
  "npm install zod",
  "sed -i 's/a/b/' src/a.ts",
  "sed --in-place 's/a/b/' src/a.ts",
])(
  "on_blocked_command ask: bash `%s` is still denied, never asked",
  async (command) => {
    expect(await bash(command, "ask")).toBe("denied");
  },
  slow(30_000),
);

test(
  "on_blocked_command ask: a command off the list is asked; deny refuses it as before",
  async () => {
    expect(await bash("sed -n 1,2p f", "ask")).toBe("asked:bash");
    expect(await bash("sed -n 1,2p f")).toBe("denied");
    expect(await bash("sed -n 1,3p README.md", "ask")).toBe("asked:bash"); // the in-place deny does not catch ordinary reads
    expect(await bash("sed -n 5,9p src/a.ts", "ask")).toBe("asked:bash");
    expect(await bash("npm run lint", "ask")).toBe("allowed"); // allowed commands never ask
  },
  slow(30_000),
);

test(
  "the project's own scripts, configured allow_commands and read-only git are allowed",
  async () => {
    expect(await bash("npm run lint")).toBe("allowed");
    expect(existsSync(join(repo.dir, "lint.out"))).toBe(true);
    expect(await bash("npm run lint -- --fix")).toBe("allowed");
    expect(await bash("echo allowed-by-config")).toBe("allowed");
    expect(await bash("git status")).toBe("allowed");
    expect(await bash("git status --short")).toBe("allowed");
    expect(await bash("git diff --stat")).toBe("allowed");
    expect(await bash("rg TODO src")).toBe("allowed");
    expect(await bash("ls -la")).toBe("allowed");
    expect(await bash("ls a; echo ---; ls b")).toBe("allowed");
    expect(await bash("cat a 2>/dev/null")).toBe("allowed");
    expect(await bash("rg x 2>&1 | head")).toBe("allowed");
    expect(await bash("find src -name '*.ts'")).toBe("allowed");
    expect(await bash("git branch --show-current")).toBe("allowed");
    expect(await bash("rg x src | head -5")).toBe("allowed");
    expect(await bash("cat src/a.ts")).toBe("allowed");
    expect(await bash("wc -l src/a.ts")).toBe("allowed");
    expect(await bash("node --version")).toBe("allowed");
    expect(await bash(`git -C ${repo.dir} diff --stat`)).toBe("allowed");
    expect(await bash("npx eslint src/a.ts")).toBe("allowed");
    expect(await bash("npx tsc --noEmit")).toBe("allowed");
    expect(await bash("npx prettier --check src/a.ts")).toBe("allowed");
    expect(await bash("make check")).toBe("allowed"); // a make target, exactly
    expect(existsSync(join(repo.dir, "make.out"))).toBe(true);
  },
  slow(60_000),
);

test(
  "a compound check command is allowed segment by segment, but its curl segment stays denied",
  async () => {
    const allowed = checkAllows("cd sub && X=1 node check.mjs");
    expect(
      await call("bash", { command: "cd sub && X=1 node check.mjs", description: "test" }, allowed),
    ).toBe("allowed");
    const withCurl = checkAllows("curl https://example.com && node check.mjs");
    expect(
      await call(
        "bash",
        { command: "curl https://example.com && node check.mjs", description: "test" },
        withCurl,
      ),
    ).toBe("denied");
  },
  slow(60_000),
);

test(
  "env files cannot even be read",
  async () => {
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
  },
  slow(60_000),
);

test(
  "protected paths cannot be edited; ordinary files can",
  async () => {
    for (const path of [
      ".env",
      "config/.env.local",
      ".git/hooks/x",
      "sub/.git/config",
      ".cheapag/state",
      "cheapag.json",
      "package-lock.json",
      "web/yarn.lock",
    ]) {
      expect(await write(path), path).toBe("denied");
    }
    expect(await write("src/ok.ts")).toBe("allowed");
  },
  slow(60_000),
);

test(
  "linked dependency dirs are readable through the worktree link but never writable; outside paths are denied",
  async () => {
    // Windows (CI 2026-10-29): OpenCode denies reads through the junction; the worker can't read linked deps there
    expect(
      await call("read", { filePath: join(repo.dir, "node_modules", "dep", "index.js") }),
    ).toBe(process.platform === "win32" ? "denied" : "allowed");
    expect(await write("node_modules/dep/evil.js")).toBe("denied");
    expect(await write(join(deps, "dep", "evil.js"))).toBe("denied");
    expect(await call("read", { filePath: "/etc/hosts" })).toBe("denied");
    expect(existsSync(join(deps, "dep", "evil.js"))).toBe(false);
    expect(lstatSync(join(repo.dir, "node_modules")).isSymbolicLink()).toBe(true);
  },
  slow(60_000),
);

test(
  "web, subtasks and skills are not even offered to the worker",
  async () => {
    expect(await call("webfetch", { url: "https://example.com", format: "text" })).toBe(
      "unavailable",
    );
    expect(await call("task", { description: "x", prompt: "y", subagent_type: "general" })).toBe(
      "unavailable",
    );
    const offered = llm.requests
      .filter((r) => r.tools)
      .at(-1)
      .tools.map((t: { function: { name: string } }) => t.function.name);
    expect(offered).not.toEqual(expect.arrayContaining(["webfetch"]));
    expect(offered).not.toContain("task");
    expect(offered).not.toContain("skill");
  },
  slow(60_000),
);

/** The JSON text's length and sha256: pins every rule, the key order inside each rule, and the order of the rules. */
function fingerprint(value: unknown) {
  const json = JSON.stringify(value);
  return `${json.length} ${createHash("sha256").update(json).digest("hex")}`;
}

const PROJECT_OPTIONS = {
  scripts: ["npm run lint", "yarn lint"],
  exact: ["make check", "node check.mjs"],
  allowCommands: ["echo allowed-by-config", "just test"],
};

test("the generated rulesets and lists are pinned exactly, rule by rule and key by key", () => {
  const generated = {
    workerDefault: workerRuleset(),
    workerAsk: workerRuleset({ onBlockedCommand: "ask" }),
    workerAllowCommands: workerRuleset({ allowCommands: PROJECT_OPTIONS.allowCommands }),
    workerFull: workerRuleset({
      ...PROJECT_OPTIONS,
      linked: ["node_modules", "web/node_modules"],
      onBlockedCommand: "deny",
    }),
    researchDefault: researchRuleset(),
    researchFull: researchRuleset(PROJECT_OPTIONS),
    baseline: baselinePermission(),
    hardDeny: HARD_DENY,
    protectedPaths: PROTECTED,
    writeOrRun: [...WRITE_OR_RUN],
  };
  const fingerprints = Object.fromEntries(
    Object.entries(generated).map(([name, value]) => [name, fingerprint(value)]),
  );
  expect(fingerprints).toEqual({
    workerDefault: "28101 1b422bac94a9b9aa07b035a776b000bfc0584be6639cf2ca40a406336d95c55e",
    workerAsk: "28100 80ab2e75c9bf83e39a014cd3bda3630d27be8ac61cf614214acf39fe1a590bff",
    workerAllowCommands: "28991 515a138137c845737c33103cf1208d15b8a660c59dfde32ae67cdc441a9e41bc",
    workerFull: "30505 b038cd314ef23d66a643ba0633d6d9fd499e25c70e282fb22cd35f4242f377c9",
    researchDefault: "25965 fa6d656ec2dd5a615f4317af5bad6f2cf3b85fda16c5d0ac99b050d640309cf1",
    researchFull: "28103 70478311241428219ce05ac60813826f880871b5030df1c068feedbf1df85edb",
    baseline: "10171 f049540a5217f72e998824697e3f7147fb0e822df5e938ed04bc25cccf4dd92e",
    hardDeny: "2281 25b99015e2d421f0a24fd5ec6d6d90554260c5bdf0bc6914bb2fbdbeff45eaf0",
    protectedPaths: "500 446f42358b21eda74b641759c6a6b30f4b780505a1f53b7d8b75d8a4f43459e4",
    writeOrRun: "176 248ebf7925a5bb3e7e1e158944d1a9f56afcc4461896d080f62b9b653ada2980",
  });
});

test("the rulesets open with the catch-all deny and close with the hard denylist", () => {
  const rulesets = [
    workerRuleset(PROJECT_OPTIONS),
    workerRuleset({ onBlockedCommand: "ask" }),
    researchRuleset(PROJECT_OPTIONS),
  ];
  const lastRules = HARD_DENY.filter((pattern) => pattern !== "*>*").map((pattern) => ({
    permission: "bash",
    pattern,
    action: "deny",
  }));
  for (const rules of rulesets) {
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "deny" });
    expect(rules.slice(-lastRules.length)).toEqual(lastRules);
  }
});

test("projectScripts lists package scripts under every manager and make targets, in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-scripts-"));
  const scripts = {
    lint: "x",
    test: "x",
    "build:prod": "x",
    "@scope/x.y-z": "x",
    "has space": "x",
    "*": "x",
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
  const makefile =
    "check:\n\techo made\nbuild: dep\nVAR := 1\n.PHONY: check\nall::\n9lives:\nx=y:\n";
  writeFileSync(join(dir, "Makefile"), makefile);
  writeFileSync(join(dir, "GNUmakefile"), "gnu-only:\ncheck:\n");
  const result = projectScripts(dir);
  expect(Object.keys(result)).toEqual(["scripts", "exact"]);
  expect(result).toEqual({
    scripts: [
      "npm run lint",
      "pnpm run lint",
      "yarn run lint",
      "bun run lint",
      "yarn lint",
      "npm run test",
      "pnpm run test",
      "yarn run test",
      "bun run test",
      "yarn test",
      "npm run build:prod",
      "pnpm run build:prod",
      "yarn run build:prod",
      "bun run build:prod",
      "yarn build:prod",
      "npm run @scope/x.y-z",
      "pnpm run @scope/x.y-z",
      "yarn run @scope/x.y-z",
      "bun run @scope/x.y-z",
      "yarn @scope/x.y-z",
      "npm test",
      "npm t",
      "pnpm test",
    ],
    exact: ["make check", "make build", "make all", "make 9lives", "make", "make gnu-only"],
  });
  rmSync(dir, { recursive: true, force: true });
});

test("projectScripts skips a package.json it cannot read or parse, but not a Makefile it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "cheapag-scripts-"));
  expect(projectScripts(dir)).toEqual({ scripts: [], exact: [] });
  writeFileSync(join(dir, "package.json"), "{ not json");
  writeFileSync(join(dir, "Makefile"), "check:\n");
  expect(projectScripts(dir)).toEqual({ scripts: [], exact: ["make check", "make"] });
  writeFileSync(join(dir, "package.json"), "null");
  expect(projectScripts(dir).scripts).toEqual([]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-scripts" }));
  expect(projectScripts(dir).scripts).toEqual([]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: "ab" }));
  expect(projectScripts(dir).scripts).toEqual([
    "npm run 0",
    "pnpm run 0",
    "yarn run 0",
    "bun run 0",
    "yarn 0",
    "npm run 1",
    "pnpm run 1",
    "yarn run 1",
    "bun run 1",
    "yarn 1",
  ]);
  rmSync(join(dir, "package.json"));
  mkdirSync(join(dir, "package.json"));
  expect(projectScripts(dir).scripts).toEqual([]);
  rmSync(join(dir, "Makefile"));
  mkdirSync(join(dir, "Makefile"));
  expect(() => projectScripts(dir)).toThrow(/EISDIR/);
  rmSync(dir, { recursive: true, force: true });
});

test("commandPrefix keeps the program and a bare second word", () => {
  const commands = [
    "npm run lint",
    "git branch -D x",
    "  rg   foo  ",
    "\tgit\tstatus\n",
    "ls -la",
    "cat ./a",
    "make check.all",
    "a _b",
    "a 9-x",
    "ls",
    "",
  ];
  expect(Object.fromEntries(commands.map((command) => [command, commandPrefix(command)]))).toEqual({
    "npm run lint": "npm run",
    "git branch -D x": "git branch",
    "  rg   foo  ": "rg foo",
    "\tgit\tstatus\n": "git status",
    "ls -la": "ls",
    "cat ./a": "cat",
    "make check.all": "make",
    "a _b": "a _b",
    "a 9-x": "a 9-x",
    ls: "ls",
    "": "",
  });
});

test("isHardDenied checks the whole line and every segment OpenCode checks", () => {
  const commands = [
    "npm install zod",
    "npm run lint",
    "git status",
    "ls && curl x",
    "ls; sudo x",
    "ls\nwget x",
    "rg x || brew list",
    "rg x | sh",
    "echo $(id)",
    "ls $(curl x)",
    "echo `id`",
    "cat .env",
    "cat a > b",
    "(curl x)",
    "  ",
    "",
  ];
  expect(Object.fromEntries(commands.map((command) => [command, isHardDenied(command)]))).toEqual({
    "npm install zod": true,
    "npm run lint": false,
    "git status": false,
    "ls && curl x": true,
    "ls; sudo x": true,
    "ls\nwget x": true,
    "rg x || brew list": true,
    "rg x | sh": true,
    "echo $(id)": true,
    "ls $(curl x)": true,
    "echo `id`": true,
    "cat .env": true,
    "cat a > b": true,
    "(curl x)": false,
    "  ": false,
    "": false,
  });
});

test("canAlwaysAllow refuses programs that can write files or run code, by their first word", () => {
  const prefixes = [
    "ls",
    "rg",
    "cat",
    "Sed",
    "",
    "git branch",
    "sed",
    "  npm run",
    "make",
    "python3 -m",
  ];
  expect(Object.fromEntries(prefixes.map((prefix) => [prefix, canAlwaysAllow(prefix)]))).toEqual({
    ls: true,
    rg: true,
    cat: true,
    Sed: true,
    "": true,
    "git branch": false,
    sed: false,
    "  npm run": false,
    make: false,
    "python3 -m": false,
  });
});

test("the rejection message is exact", () => {
  expect(rejectionMessage("npm install zod")).toBe(
    "Not allowed in cheapag: `npm install zod`. If you need a dependency, use the question tool. Otherwise finish and list it in risks.",
  );
});
