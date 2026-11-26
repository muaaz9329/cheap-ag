import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { hermeticHome as makeHome, serverEntry, tempRepo, type Logins } from "./harness.js";

/** A hermetic home for running the CLI, removed after the test. */
function hermeticHome(logins?: Logins) {
  const h = makeHome(logins);
  onTestFinished(() => rmSync(h.home, { recursive: true, force: true }));
  return h;
}

/** A temp git repo, removed after the test. */
function repo() {
  const r = tempRepo();
  onTestFinished(r.cleanup);
  return r.dir;
}

/** Runs the real `cheapag allow <args>` in `cwd`; returns its exit code and both output streams. */
function allow(cwd: string, env: Record<string, string>, args: string[] = []) {
  const run = spawnSync(process.execPath, [serverEntry, "allow", ...args], {
    cwd,
    env,
    stdio: "pipe",
  });
  return { status: run.status, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const consentFile = (dir: string) => join(dir, ".cheapag", "consent.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("no flag: consent for all models, the gate's models, exit 0", () => {
  const dir = repo();
  const { env } = hermeticHome({ "opencode-go": "k" });
  expect(allow(dir, env)).toEqual({
    status: 0,
    stdout: [
      `✓ ${dir}: code may go to OpenCode Go (all models)`,
      "  models: opencode-go/deepseek-v4.1-flash, opencode-go/qwen3.8-flash, opencode-go/deepseek-v4-pro, opencode-go/qwen3.7-plus, opencode-go/glm-5.3, opencode-go/kimi-k3",
      "",
    ].join("\n"),
    stderr: "",
  });
  const consent = readJson(consentFile(dir));
  expect(Object.keys(consent)).toEqual(["mode", "provider", "approvedAt", "route"]);
  expect(consent).toMatchObject({ mode: "all", provider: "opencode-go" });
  expect(consent.approvedAt).toMatch(ISO);
});

test("--zdr-only on OpenCode Go: zero-retention models only, exit 0", () => {
  const dir = repo();
  const { env } = hermeticHome({ "opencode-go": "k" });
  expect(allow(dir, env, ["--zdr-only"])).toEqual({
    status: 0,
    stdout: [
      `✓ ${dir}: code may go to OpenCode Go (zero-retention only)`,
      "  models: opencode-go/deepseek-v4.1-flash, opencode-go/qwen3.8-flash, opencode-go/deepseek-v4-pro, opencode-go/qwen3.7-plus",
      "",
    ].join("\n"),
    stderr: "",
  });
  expect(readJson(consentFile(dir))).toMatchObject({ mode: "zdr-only", provider: "opencode-go" });
});

test("--models trims each name and drops empty ones; the list has no route", () => {
  const dir = repo();
  const { env } = hermeticHome({ "opencode-go": "k" });
  const list = " opencode-go/deepseek-v4.1-flash , ,opencode-go/kimi-k3,";
  expect(allow(dir, env, ["--models", list])).toEqual({
    status: 0,
    stdout: [
      `✓ ${dir}: code may go to OpenCode Go (models opencode-go/deepseek-v4.1-flash, opencode-go/kimi-k3)`,
      "  models: opencode-go/deepseek-v4.1-flash, opencode-go/kimi-k3",
      "",
    ].join("\n"),
    stderr: "",
  });
  const consent = readJson(consentFile(dir));
  expect(Object.keys(consent)).toEqual(["mode", "models", "provider", "approvedAt"]);
  expect(consent).toMatchObject({
    mode: "models",
    models: ["opencode-go/deepseek-v4.1-flash", "opencode-go/kimi-k3"],
    provider: "opencode-go",
  });
  expect(consent.approvedAt).toMatch(ISO);
});

test("a consent the gate still blocks is written, prints the block with !, and exits 0", () => {
  const dir = repo();
  const { env } = hermeticHome({ deepseek: "k" });
  expect(allow(dir, env, ["--zdr-only"])).toEqual({
    status: 0,
    stdout: [
      `✓ ${dir}: code may go to DeepSeek (zero-retention only)`,
      "! FAIL reason: no allowed model for DeepSeek under this repo's consent (zero-retention only); ask the user to widen it with /cheapag:allow",
      "",
    ].join("\n"),
    stderr: "",
  });
  expect(readJson(consentFile(dir))).toMatchObject({ mode: "zdr-only", provider: "deepseek" });
});

test.each([
  [["--everything"]],
  [["--zdr-only", "--models"]],
  [["--zdr-only", "x"]],
  [["--models"]],
  [["--models", ""]],
  [["--models", " , ,"]],
  [["--models", "a", "b"]],
  [["x", "--zdr-only"]],
])("allow %j prints the usage, exits 1, and writes nothing", (args) => {
  const dir = repo();
  const { env } = hermeticHome({ "opencode-go": "k" });
  expect(allow(dir, env, args)).toEqual({
    status: 1,
    stdout: "✗ usage: cheapag allow [--zdr-only | --models <provider/model,…>]\n",
    stderr: "",
  });
  expect(existsSync(join(dir, ".cheapag"))).toBe(false);
});

test("a bad argument is reported before a missing login", () => {
  const dir = repo();
  expect(allow(dir, hermeticHome().env, ["--everything"]).stdout).toBe(
    "✗ usage: cheapag allow [--zdr-only | --models <provider/model,…>]\n",
  );
});

test("without a login: the login hint, exit 1, nothing written", () => {
  const dir = repo();
  expect(allow(dir, hermeticHome().env)).toEqual({
    status: 1,
    stdout: "✗ no worker provider; run npx cheap-agent login first\n",
    stderr: "",
  });
  expect(existsSync(join(dir, ".cheapag"))).toBe(false);
});

test("a missing login is reported before a missing repo", () => {
  const { home, env } = hermeticHome();
  expect(allow(home, env).stdout).toBe("✗ no worker provider; run npx cheap-agent login first\n");
});

test("outside a git repo: the error message, exit 1, nothing written", () => {
  const { home, env } = hermeticHome({ "opencode-go": "k" });
  const outside = join(home, "not-a-repo");
  mkdirSync(outside);
  expect(allow(outside, env)).toEqual({
    status: 1,
    stdout: `✗ ${outside} is not inside a git repository\n`,
    stderr: "",
  });
  expect(existsSync(join(outside, ".cheapag"))).toBe(false);
});

test("a key-shaped string in the printed path is redacted, on success and on error", () => {
  const { home, env } = hermeticHome({ "opencode-go": "k" });
  const keyLike = "sk-0123456789abcdefABCD";
  const outside = join(home, keyLike);
  mkdirSync(outside);
  expect(allow(outside, env).stdout).toBe(
    `✗ ${join(home, "[redacted]")} is not inside a git repository\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: outside, stdio: "pipe" });
  const lines = allow(outside, env).stdout.split("\n");
  expect(lines[0]).toBe(`✓ ${join(home, "[redacted]")}: code may go to OpenCode Go (all models)`);
  expect(lines.join("\n")).not.toContain(keyLike);
});

test("a repo that does not ignore .cheapag/ gets it in .git/info/exclude, with a line saying so", () => {
  const dir = repo();
  const exclude = join(dir, ".git", "info", "exclude");
  writeFileSync(exclude, "# kept\n");
  const { env } = hermeticHome({ "opencode-go": "k" });
  const { status, stdout } = allow(dir, env);
  expect(status).toBe(0);
  expect(
    stdout.endsWith("\n✓ .cheapag/ added to .git/info/exclude (local, never committed)\n"),
  ).toBe(true);
  expect(readFileSync(exclude, "utf8")).toBe("# kept\n.cheapag/\n");
});

test("a repo without .git/info gets the folder and the exclude file", () => {
  const dir = repo();
  rmSync(join(dir, ".git", "info"), { recursive: true, force: true });
  const { env } = hermeticHome({ "opencode-go": "k" });
  expect(allow(dir, env).stdout).toContain(
    "✓ .cheapag/ added to .git/info/exclude (local, never committed)\n",
  );
  expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toBe(".cheapag/\n");
});

// pins a bug: a linked worktree's .git is a file, so making .git/info throws after the consent is written
test("in a linked worktree that does not ignore .cheapag/, allow writes the consent, then crashes", () => {
  const dir = repo();
  writeFileSync(join(dir, ".git", "info", "exclude"), "");
  const { home, env } = hermeticHome({ "opencode-go": "k" });
  const worktree = join(home, "linked");
  execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: dir, stdio: "pipe" });
  const { status, stdout, stderr } = allow(worktree, env);
  expect(status).toBe(1);
  expect(stdout.split("\n")[0]).toBe(`✓ ${worktree}: code may go to OpenCode Go (all models)`);
  expect(stdout).not.toContain(".git/info/exclude");
  expect(stderr).toContain("ENOTDIR");
  expect(readJson(consentFile(worktree))).toMatchObject({ mode: "all", provider: "opencode-go" });
});

test("a repo that ignores .cheapag/ through its own .gitignore is left alone", () => {
  const dir = repo();
  writeFileSync(join(dir, ".git", "info", "exclude"), "");
  writeFileSync(join(dir, ".gitignore"), ".cheapag/\n");
  const { env } = hermeticHome({ "opencode-go": "k" });
  expect(allow(dir, env).stdout).not.toContain(".git/info/exclude");
  expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toBe("");
});
