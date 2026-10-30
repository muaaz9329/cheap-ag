import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, removeDir, startServer, tempRepo } from "./harness.js";

const REPORT = { summary: "did it", risks: [], review: [], missing: [] };
const execGit = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
/** The single job worktree under `dir` (during a run). */
const worktreeOf = (dir: string) => join(dir, ".cheapag", "worktrees", readdirSync(join(dir, ".cheapag", "worktrees"))[0]);
const plan = (doneWhen: string) => `# Workspace\n\n## 1 step\nfiles: src/out.txt\ndo: write out.txt\ndone-when: ${doneWhen}\n`;

/** A repo (state set up by `prepare`), the plan written uncommitted, a scripted fake worker, and a server on both. */
async function scenario(opts: { prepare?: (dir: string, git: (...a: string[]) => string) => void; doneWhen?: string; actions?: (dir: string) => Action[] }) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  opts.prepare?.(repo.dir, repo.git);
  mkdirSync(join(repo.dir, ".plan"), { recursive: true });
  writeFileSync(join(repo.dir, ".plan", "p.md"), plan(opts.doneWhen ?? "out.txt exists"));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(...(opts.actions?.(repo.dir) ?? [{ edit: "src/out.txt", content: "out\n" }, { tool: "write" }, { finish: REPORT }]));
  const server = await startServer({ cwd: repo.dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: ".plan/p.md", steps: "1" });
  return { repo, fake, text, worktree: fake.recorded.sessions[0]?.directory };
}

test("the worker sees the uncommitted plan, uncommitted edits and untracked files; job creation leaves the checkout alone", async () => {
  const seen: Record<string, unknown> = {};
  const { repo, text } = await scenario({
    prepare: (dir) => {
      writeFileSync(join(dir, "README.md"), "# fixture\n\nuncommitted edit\n");
      writeFileSync(join(dir, "notes.txt"), "untracked\n");
    },
    // every check runs inside the worktree, so passing proves the worker could see it
    doneWhen: "`grep -q 'uncommitted edit' README.md` and `test -f notes.txt` and `test -f .plan/p.md` and `test -f src/out.txt`",
    actions: (dir) => [
      {
        hook: () => {
          // mid-job: the main checkout is exactly as the developer left it, with no stash entry made
          seen.readme = readFileSync(join(dir, "README.md"), "utf8");
          seen.stashes = execGit(dir, "stash", "list");
          seen.cheapagCopied = existsSync(join(worktreeOf(dir), ".cheapag")); // the state dir is never carried over
        },
      },
      { edit: "src/out.txt", content: "out\n" },
      { tool: "write" },
      { finish: REPORT },
    ],
  });
  expect(text.split("\n")[0]).toMatch(/^OK j[0-9a-z]{4} step=1 files=1 \+1\/-0 tests=pass /);
  expect(text).toContain("\nchanged:\n  A src/out.txt +1\n"); // only the worker's change, none of the carried-over state
  expect(seen).toEqual({ readme: "# fixture\n\nuncommitted edit\n", stashes: "", cheapagCopied: false });
  // after landing: the developer's own changes are intact and still uncommitted, alongside the worker's
  expect(readFileSync(join(repo.dir, "README.md"), "utf8")).toBe("# fixture\n\nuncommitted edit\n");
  expect(repo.git("status", "--porcelain", "--", "README.md", "notes.txt", "src")).toBe(" M README.md\n?? notes.txt\n?? src/\n");
  expect(repo.git("log", "--oneline").trim().split("\n")).toHaveLength(1);
});

test("dependency directories are linked into the worktree, never diffed or landed, and unlinked afterwards", async () => {
  const { repo, text, worktree } = await scenario({
    prepare: (dir) => {
      // deliberately not gitignored: a symlink would otherwise show up as a new file in the diff
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
    },
    doneWhen: "`node -e \"process.exit(require('dep') === 42 ? 0 : 1)\"` succeeds",
  });
  expect(text.split("\n")[0]).toMatch(/^OK .* files=1 .* tests=pass /);
  expect(text).not.toContain("node_modules");
  expect(readFileSync(join(repo.dir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 42;\n"); // the real dir survives
  expect(existsSync(worktree)).toBe(false);
});

test("a dependency dir the repo already gitignores is not named in add's pathspec (git 2.55 rejects it)", async () => {
  const { repo, text } = await scenario({
    prepare: (dir, git) => {
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      git("add", ".gitignore");
      git("commit", "-q", "-m", "ignore node_modules");
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
    },
    doneWhen: "`node -e \"process.exit(require('dep') === 42 ? 0 : 1)\"` succeeds",
  });
  expect(text.split("\n")[0]).toMatch(/^OK .* files=1 .* tests=pass /);
  expect(text).not.toContain("node_modules");
  expect(repo.git("status", "--porcelain", "--untracked-files=all")).not.toContain("node_modules");
});

test("a directory-only gitignore rule leaves the worktree's dependency symlink unignored, so it is still excluded", async () => {
  const { repo, text } = await scenario({
    prepare: (dir, git) => {
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      git("add", ".gitignore");
      git("commit", "-q", "-m", "ignore node_modules dirs");
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
    },
    doneWhen: "`test -f node_modules/dep/index.js`",
  });
  expect(text.split("\n")[0]).toMatch(/^OK .* files=1 .* tests=pass /);
  expect(text).not.toContain("node_modules");
  expect(repo.git("status", "--porcelain", "--untracked-files=all")).not.toContain("node_modules");
});

test("a failed job keeps its worktree with the dependency link in place", async () => {
  const { text, worktree } = await scenario({
    prepare: (dir) => mkdirSync(join(dir, "node_modules", "dep"), { recursive: true }),
    doneWhen: "`false`", // fails every attempt; unscripted fix prompts just go idle
  });
  expect(text).toMatch(/^FAIL /);
  expect(readlinkSync(join(worktree, "node_modules"))).toMatch(/node_modules$/);
});

test("link_dirs is configurable in cheapag.json", async () => {
  const { text } = await scenario({
    prepare: (dir) => {
      mkdirSync(join(dir, "deps"));
      writeFileSync(join(dir, "deps", "lib.txt"), "lib\n");
      writeFileSync(join(dir, "cheapag.json"), JSON.stringify({ link_dirs: ["deps"] }));
    },
    doneWhen: "`test -f deps/lib.txt`",
  });
  expect(text.split("\n")[0]).toMatch(/^OK .* tests=pass /);
  expect(text).not.toContain("deps/");
});

test("build output is never linked: a link_dirs entry naming it is a config error", async () => {
  const { text, fake } = await scenario({ prepare: (dir) => writeFileSync(join(dir, "cheapag.json"), JSON.stringify({ link_dirs: ["node_modules", "dist/"] })) });
  expect(text).toMatch(/^FAIL reason: .*cheapag\.json: link_dirs entry "dist\/" is build output, which is never linked$/);
  expect(fake.recorded.sessions).toEqual([]);
});

test("worker edits to files the developer had not committed yet (incl. the plan) land", async () => {
  const { repo, text } = await scenario({
    prepare: (dir) => writeFileSync(join(dir, "notes.txt"), "draft\n"),
    actions: () => [
      { edit: "notes.txt", content: "draft\nworker addition\n" },
      { edit: ".plan/p.md", content: plan("out.txt exists") + "\n<!-- done by worker -->\n" },
      { tool: "edit" },
      { finish: REPORT },
    ],
  });
  expect(text).toMatch(/^OK /);
  expect(readFileSync(join(repo.dir, "notes.txt"), "utf8")).toBe("draft\nworker addition\n");
  expect(readFileSync(join(repo.dir, ".plan", "p.md"), "utf8")).toContain("<!-- done by worker -->");
  expect(repo.git("status", "--porcelain", "--", "notes.txt", ".plan")).toBe("?? .plan/\n?? notes.txt\n"); // still untracked
});

test("a committed dependency dir is not linked, and worker edits inside it land", async () => {
  const { repo, text } = await scenario({
    prepare: (dir, git) => {
      mkdirSync(join(dir, "vendor", "lib"), { recursive: true });
      writeFileSync(join(dir, "vendor", "lib", "a.txt"), "v1\n");
      git("add", "vendor");
      git("commit", "-q", "-m", "vendor");
    },
    actions: () => [{ edit: "vendor/lib/a.txt", content: "v2\n" }, { tool: "edit" }, { finish: REPORT }],
  });
  expect(text).toContain("\n  M vendor/lib/a.txt +1 -1\n");
  expect(readFileSync(join(repo.dir, "vendor", "lib", "a.txt"), "utf8")).toBe("v2\n");
});

test("an untracked nested repository is left out of the worktree and does not break the job", async () => {
  const { text } = await scenario({
    prepare: (dir) => {
      mkdirSync(join(dir, "sub"));
      execFileSync("git", ["init", "-q"], { cwd: join(dir, "sub") });
      writeFileSync(join(dir, "sub", "file.txt"), "nested\n");
    },
    doneWhen: "`test ! -e sub`",
  });
  expect(text.split("\n")[0]).toMatch(/^OK .* tests=pass /);
  expect(text).not.toContain("sub");
});

test.each([
  ["a rebase", (dir: string, git: (...a: string[]) => string) => {
    conflictingBranches(dir, git);
    try {
      git("rebase", "-q", "side");
    } catch {
      // stops on the conflict
    }
  }, "FAIL reason: a rebase is in progress in the working tree; finish or abort it, then delegate again"],
  ["unresolved conflicts without a merge (a conflicted stash pop)", (dir: string, git: (...a: string[]) => string) => {
    writeFileSync(join(dir, "README.md"), "stashed\n");
    git("stash", "-q");
    writeFileSync(join(dir, "README.md"), "committed\n");
    git("commit", "-q", "-am", "c");
    try {
      git("stash", "pop", "-q");
    } catch {
      // leaves README.md unmerged, with no MERGE_HEAD
    }
  }, "FAIL reason: there are unresolved conflicts in the working tree; finish or abort it, then delegate again"],
])("delegating with %s in the checkout is refused before any job starts", async (_, prepare, expected) => {
  const { text, fake } = await scenario({ prepare });
  expect(text).toBe(expected);
  expect(fake.recorded.sessions).toEqual([]);
});

/** `main` and `side` both change README.md's only line. */
function conflictingBranches(dir: string, git: (...a: string[]) => string) {
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(dir, "README.md"), "side\n");
  git("commit", "-q", "-am", "side");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "README.md"), "main\n");
  git("commit", "-q", "-am", "main");
}

test("delegating during an in-progress merge is refused before any job starts", async () => {
  const { text, fake, repo } = await scenario({
    prepare: (dir, git) => {
      conflictingBranches(dir, git);
      try {
        git("merge", "-q", "side");
      } catch {
        // the conflict is the point
      }
    },
  });
  expect(text).toBe("FAIL reason: a merge is in progress in the working tree; finish or abort it, then delegate again");
  expect(fake.recorded.sessions).toEqual([]);
  expect(existsSync(join(repo.dir, ".cheapag", "worktrees"))).toBe(false);
});

test("a repository with no commits yet is refused before any job starts", async () => {
  // tempRepo always commits, so build the bare-init repo inline
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-test-")));
  onTestFinished(() => removeDir(dir));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# fixture\n"); // files, but no commit
  mkdirSync(join(dir, ".plan"), { recursive: true });
  writeFileSync(join(dir, ".plan", "p.md"), plan("out.txt exists"));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  const server = await startServer({ cwd: dir, env: { CHEAPAG_OPENCODE_URL: fake.url }, logins: { "opencode-go": "k" }, allow: [] });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: ".plan/p.md", steps: "1" });
  expect(text).toBe('FAIL reason: this repository has no commits yet, and Cheap Agent starts each job from the last commit. Make a first commit, then delegate again: git add -A && git commit -m "start"');
  expect(fake.recorded.sessions).toEqual([]);
  expect(existsSync(join(dir, ".cheapag", "jobs"))).toBe(false);
});
