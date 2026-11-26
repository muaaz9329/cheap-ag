import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { startFakeOpencode, type Action } from "./fake-opencode.js";
import { callText, removeDir, startServer, tempRepo } from "./harness.js";
import {
  callRoot,
  conflictPaths,
  createWorktree,
  git,
  hasCommits,
  jobWorktree,
  land,
  leftoverMarkers,
  operationInProgress,
  projectRoot,
  reapply,
  removeWorktree,
  withLock,
  worktreeDiff,
  type Worktree,
} from "../src/workspace.js";

/** Records the git commands and file writes made while `trace.state.on` is set, in order. */
const trace = vi.hoisted(() => {
  type Run = (...args: unknown[]) => unknown;
  type Options = { cwd?: string; env?: Record<string, string | undefined> } | undefined;
  const state = { on: false, calls: [] as string[] };
  // the leading path arguments of each recorded file operation; contents and options are left out
  const pathCounts = {
    copyFileSync: 2,
    cpSync: 2,
    linkSync: 2,
    mkdirSync: 1,
    renameSync: 2,
    rmSync: 1,
    symlinkSync: 2,
    unlinkSync: 1,
    writeFileSync: 1,
  };
  function command(run: Run): Run {
    return (...args) => {
      if (state.on) {
        const [file, argv, options] = args as [string, string[], Options];
        const index = options?.env?.GIT_INDEX_FILE;
        const indexNote = index === undefined ? [] : [`[index ${index}]`];
        state.calls.push([file, `@${options?.cwd}`, ...argv, ...indexNote].join(" "));
      }
      return run(...args);
    };
  }
  function fileWrite(name: keyof typeof pathCounts, run: Run): Run {
    return (...args) => {
      if (state.on) state.calls.push([name, ...args.slice(0, pathCounts[name])].join(" "));
      return run(...args);
    };
  }
  return { state, pathCounts, command, fileWrite };
});

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: trace.command(actual.execFileSync as (...args: unknown[]) => unknown),
    spawnSync: trace.command(actual.spawnSync as (...args: unknown[]) => unknown),
  };
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const names = Object.keys(trace.pathCounts) as (keyof typeof trace.pathCounts)[];
  const wrapped = names.map((name) => [
    name,
    trace.fileWrite(name, actual[name] as (...args: unknown[]) => unknown),
  ]);
  return { ...actual, ...Object.fromEntries(wrapped) };
});

const REPORT = { summary: "did it", risks: [], review: [], missing: [] };
const execGit = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir }).toString();
/** The single job worktree under `dir` (during a run). */
const worktreeOf = (dir: string) =>
  join(dir, ".cheapag", "worktrees", readdirSync(join(dir, ".cheapag", "worktrees"))[0]);
const plan = (doneWhen: string) =>
  `# Workspace\n\n## 1 step\nfiles: src/out.txt\ndo: write out.txt\ndone-when: ${doneWhen}\n`;

/** A repo (state set up by `prepare`), the plan written uncommitted, a scripted fake worker, and a server on both. */
async function scenario(opts: {
  prepare?: (dir: string, git: (...a: string[]) => string) => void;
  doneWhen?: string;
  actions?: (dir: string) => Action[];
}) {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  opts.prepare?.(repo.dir, repo.git);
  mkdirSync(join(repo.dir, ".plan"), { recursive: true });
  writeFileSync(join(repo.dir, ".plan", "p.md"), plan(opts.doneWhen ?? "out.txt exists"));
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(
    ...(opts.actions?.(repo.dir) ?? [
      { edit: "src/out.txt", content: "out\n" },
      { tool: "write" },
      { finish: REPORT },
    ]),
  );
  const server = await startServer({
    cwd: repo.dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
    allow: [],
  });
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
    doneWhen:
      "`grep -q 'uncommitted edit' README.md` and `test -f notes.txt` and `test -f .plan/p.md` and `test -f src/out.txt`",
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
  expect(seen).toEqual({
    readme: "# fixture\n\nuncommitted edit\n",
    stashes: "",
    cheapagCopied: false,
  });
  // after landing: the developer's own changes are intact and still uncommitted, alongside the worker's
  expect(readFileSync(join(repo.dir, "README.md"), "utf8")).toBe("# fixture\n\nuncommitted edit\n");
  expect(repo.git("status", "--porcelain", "--", "README.md", "notes.txt", "src")).toBe(
    " M README.md\n?? notes.txt\n?? src/\n",
  );
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
  expect(readFileSync(join(repo.dir, "node_modules", "dep", "index.js"), "utf8")).toBe(
    "module.exports = 42;\n",
  ); // the real dir survives
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
  const { text, fake } = await scenario({
    prepare: (dir) =>
      writeFileSync(
        join(dir, "cheapag.json"),
        JSON.stringify({ link_dirs: ["node_modules", "dist/"] }),
      ),
  });
  expect(text).toMatch(
    /^FAIL reason: .*cheapag\.json: link_dirs entry "dist\/" is build output, which is never linked$/,
  );
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
  expect(readFileSync(join(repo.dir, ".plan", "p.md"), "utf8")).toContain(
    "<!-- done by worker -->",
  );
  expect(repo.git("status", "--porcelain", "--", "notes.txt", ".plan")).toBe(
    "?? .plan/\n?? notes.txt\n",
  ); // still untracked
});

test("a committed dependency dir is not linked, and worker edits inside it land", async () => {
  const { repo, text } = await scenario({
    prepare: (dir, git) => {
      mkdirSync(join(dir, "vendor", "lib"), { recursive: true });
      writeFileSync(join(dir, "vendor", "lib", "a.txt"), "v1\n");
      git("add", "vendor");
      git("commit", "-q", "-m", "vendor");
    },
    actions: () => [
      { edit: "vendor/lib/a.txt", content: "v2\n" },
      { tool: "edit" },
      { finish: REPORT },
    ],
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
  [
    "a rebase",
    (dir: string, git: (...a: string[]) => string) => {
      conflictingBranches(dir, git);
      try {
        git("rebase", "-q", "side");
      } catch {
        // stops on the conflict
      }
    },
    "FAIL reason: a rebase is in progress in the working tree; finish or abort it, then delegate again",
  ],
  [
    "unresolved conflicts without a merge (a conflicted stash pop)",
    (dir: string, git: (...a: string[]) => string) => {
      writeFileSync(join(dir, "README.md"), "stashed\n");
      git("stash", "-q");
      writeFileSync(join(dir, "README.md"), "committed\n");
      git("commit", "-q", "-am", "c");
      try {
        git("stash", "pop", "-q");
      } catch {
        // leaves README.md unmerged, with no MERGE_HEAD
      }
    },
    "FAIL reason: there are unresolved conflicts in the working tree; finish or abort it, then delegate again",
  ],
])(
  "delegating with %s in the checkout is refused before any job starts",
  async (_, prepare, expected) => {
    const { text, fake } = await scenario({ prepare });
    expect(text).toBe(expected);
    expect(fake.recorded.sessions).toEqual([]);
  },
);

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
  expect(text).toBe(
    "FAIL reason: a merge is in progress in the working tree; finish or abort it, then delegate again",
  );
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
  const server = await startServer({
    cwd: dir,
    env: { CHEAPAG_OPENCODE_URL: fake.url },
    logins: { "opencode-go": "k" },
    allow: [],
  });
  onTestFinished(server.close);
  const text = await callText(server.client, "delegate", { plan: ".plan/p.md", steps: "1" });
  expect(text).toBe(
    'FAIL reason: this repository has no commits yet, and Cheap Agent starts each job from the last commit. Make a first commit, then delegate again: git add -A && git commit -m "start"',
  );
  expect(fake.recorded.sessions).toEqual([]);
  expect(existsSync(join(dir, ".cheapag", "jobs"))).toBe(false);
});

const worktrees = (repo: { git: (...a: string[]) => string }) =>
  repo
    .git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

// permission bits mean nothing to root or on Windows
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a worktree that cannot be filled is removed again, links first, and the error is passed on",
  () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    mkdirSync(join(repo.dir, "node_modules"));
    writeFileSync(join(repo.dir, "secret.txt"), "x");
    chmodSync(join(repo.dir, "secret.txt"), 0o000); // an untracked file that cannot be copied
    onTestFinished(() => chmodSync(join(repo.dir, "secret.txt"), 0o644));
    expect(() => createWorktree(repo.dir, "jfail", ["node_modules"])).toThrow(/EACCES/);
    expect(existsSync(join(repo.dir, ".cheapag", "worktrees", "jfail"))).toBe(false);
    expect(worktrees(repo)).toBe(1);
    expect(existsSync(join(repo.dir, "node_modules"))).toBe(true);
  },
);

test("removing a worktree git no longer recognises deletes the folder and prunes git's record", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, "node_modules"));
  writeFileSync(join(repo.dir, "node_modules", "dep.js"), "x");
  const tree = createWorktree(repo.dir, "jgone", ["node_modules"]);
  expect(worktrees(repo)).toBe(2);
  rmSync(join(tree.path, ".git")); // no longer a worktree as far as git can tell
  removeWorktree(repo.dir, tree);
  expect(existsSync(tree.path)).toBe(false);
  expect(worktrees(repo)).toBe(1);
  expect(readFileSync(join(repo.dir, "node_modules", "dep.js"), "utf8")).toBe("x"); // the linked dir itself is untouched
});

test("land lock: a file that is not a Cheap Agent lock has no live holder and is replaced; a lock removed meanwhile is not an error", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const lock = join(repo.dir, ".cheapag", "land.lock");
  mkdirSync(join(repo.dir, ".cheapag"));
  writeFileSync(lock, "garbage, not JSON");
  expect(await withLock(repo.dir, () => JSON.parse(readFileSync(lock, "utf8")).pid)).toBe(
    process.pid,
  );
  expect(existsSync(lock)).toBe(false);
  // the holder's own work removed the lock file: release finds nothing and leaves it so
  expect(await withLock(repo.dir, () => (rmSync(lock), "done"))).toBe("done");
  expect(
    readdirSync(join(repo.dir, ".cheapag")).filter((name) => name.startsWith("land.lock")),
  ).toEqual([]);
});

/** A trace line or git output with the temp repo path, object hashes and lock tokens replaced by stable names. */
function stable(root: string, text: string) {
  return text
    .replaceAll(root, "<root>")
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/land\.lock\.\d+\.[0-9a-f]{16}/g, "land.lock.<mine>")
    .replace(/land\.lock\.stale\.[0-9a-f]{8}/g, "land.lock.<stale>");
}

/** Runs `action` with tracing on; returns its result and the stable trace. */
async function traced<T>(root: string, action: () => T | Promise<T>) {
  trace.state.calls = [];
  trace.state.on = true;
  try {
    const result = await action();
    return { result, calls: trace.state.calls.map((call) => stable(root, call)) };
  } finally {
    trace.state.on = false;
  }
}

/** A committed vendor/, then a tracked edit, an untracked file and symlink, an untracked nested repo, untracked dependency dirs, and an untracked file named like a dependency dir. */
function workingRepo() {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const inRepo = (...parts: string[]) => join(repo.dir, ...parts);
  mkdirSync(inRepo("vendor"));
  writeFileSync(inRepo("vendor", "lib.txt"), "v1\n");
  repo.git("add", "vendor");
  repo.git("commit", "-q", "-m", "vendor");
  writeFileSync(inRepo("README.md"), "# fixture\n\nedited\n");
  writeFileSync(inRepo("notes.txt"), "untracked\n");
  symlinkSync("notes.txt", inRepo("alias"));
  mkdirSync(inRepo("sub"));
  execFileSync("git", ["init", "-q"], { cwd: inRepo("sub") });
  writeFileSync(inRepo("sub", "file.txt"), "nested\n");
  mkdirSync(inRepo("node_modules", "dep"), { recursive: true });
  writeFileSync(inRepo("node_modules", "dep", "index.js"), "x\n");
  mkdirSync(inRepo("packages", "app", "node_modules"), { recursive: true });
  writeFileSync(inRepo("packages", "app", "node_modules", "pkg.js"), "y\n");
  writeFileSync(inRepo("deps"), "a file, not a dir\n");
  return { ...repo, inRepo };
}

const LINK_DIRS = ["node_modules", "vendor", "deps", "missing", "packages/app/node_modules"];

/** A job worktree whose worker edits the developer's README edit, their untracked notes.txt, and adds src/new.txt. */
function workerChanges(repo: ReturnType<typeof workingRepo>, job: string) {
  const tree = createWorktree(repo.dir, job, LINK_DIRS);
  writeFileSync(join(tree.path, "README.md"), "# fixture\n\nedited\nworker\n");
  writeFileSync(join(tree.path, "notes.txt"), "untracked\nworker\n");
  mkdirSync(join(tree.path, "src"));
  writeFileSync(join(tree.path, "src", "new.txt"), "new\n");
  mkdirSync(repo.inRepo(".cheapag", "jobs", job), { recursive: true });
  return { tree, ...worktreeDiff(tree) };
}

// symlinks need privileges on Windows, where dependency links are junctions and git takes extra -c flags
const posix = test.skipIf(process.platform === "win32");

posix(
  "createWorktree: git commands and file writes in order; the worktree carries the developer's state, the checkout is untouched",
  async () => {
    const repo = workingRepo();
    const statusBefore = repo.git("status", "--porcelain", "--untracked-files=all");
    const head = repo.git("rev-parse", "HEAD").trim();
    const { result: tree, calls } = await traced(repo.dir, () =>
      createWorktree(repo.dir, "j1", LINK_DIRS),
    );
    expect(calls).toEqual([
      "git @<root> rev-parse HEAD",
      "git @<root> stash create",
      "git @<root> worktree add --detach <root>/.cheapag/worktrees/j1 <sha>",
      "git @<root>/.cheapag/worktrees/j1 stash apply --quiet <sha>",
      "git @<root> ls-files --others --exclude-standard -z -- . :(exclude,top,literal).cheapag :(exclude,top,literal)node_modules :(exclude,top,literal)vendor :(exclude,top,literal)deps :(exclude,top,literal)missing :(exclude,top,literal)packages/app/node_modules",
      "mkdirSync <root>/.cheapag/worktrees/j1",
      "cpSync <root>/alias <root>/.cheapag/worktrees/j1/alias",
      "mkdirSync <root>/.cheapag/worktrees/j1",
      "cpSync <root>/notes.txt <root>/.cheapag/worktrees/j1/notes.txt",
      "mkdirSync <root>/.cheapag/worktrees/j1",
      "symlinkSync <root>/node_modules <root>/.cheapag/worktrees/j1/node_modules",
      "mkdirSync <root>/.cheapag/worktrees/j1/packages/app",
      "symlinkSync <root>/packages/app/node_modules <root>/.cheapag/worktrees/j1/packages/app/node_modules",
      "git @<root>/.cheapag/worktrees/j1 check-ignore -q -- node_modules",
      "git @<root>/.cheapag/worktrees/j1 check-ignore -q -- packages/app/node_modules",
      "git @<root>/.cheapag/worktrees/j1 add -A -- . :(exclude,top,literal).cheapag :(exclude,top,literal)node_modules :(exclude,top,literal)packages/app/node_modules",
      "git @<root>/.cheapag/worktrees/j1 write-tree",
    ]);
    const path = repo.inRepo(".cheapag", "worktrees", "j1");
    expect(tree).toEqual({
      path,
      head,
      stash: expect.stringMatching(/^[0-9a-f]{40}$/),
      base: expect.stringMatching(/^[0-9a-f]{40}$/),
      links: [join(path, "node_modules"), join(path, "packages", "app", "node_modules")],
      linked: ["node_modules", "packages/app/node_modules"],
    });
    expect(repo.git("ls-tree", "-r", "--name-only", tree.base)).toBe(
      "README.md\nalias\nnotes.txt\nvendor/lib.txt\n",
    );
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("# fixture\n\nedited\n");
    expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe("untracked\n");
    expect(readlinkSync(join(path, "alias"))).toBe("notes.txt");
    expect(readlinkSync(join(path, "node_modules"))).toBe(repo.inRepo("node_modules"));
    expect(readlinkSync(join(path, "packages", "app", "node_modules"))).toBe(
      repo.inRepo("packages", "app", "node_modules"),
    );
    expect(lstatSync(join(path, "vendor")).isDirectory()).toBe(true);
    for (const absent of ["sub", "deps", "missing", ".cheapag"])
      expect(existsSync(join(path, absent))).toBe(false);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
    expect(repo.git("stash", "list")).toBe("");
  },
);

posix("createWorktree on a clean checkout has no stash, and its base is HEAD's tree", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const tree = createWorktree(repo.dir, "j1", ["node_modules"]);
  expect(tree.stash).toBeNull();
  expect(tree.base).toBe(repo.git("rev-parse", "HEAD^{tree}").trim());
  expect(tree.links).toEqual([]);
  expect(tree.linked).toEqual([]);
});

posix(
  "worktreeDiff: git commands in order; per-file stats with statuses, binary counts as 0, linked dirs left out",
  async () => {
    const repo = workingRepo();
    const tree = createWorktree(repo.dir, "j1", LINK_DIRS);
    writeFileSync(join(tree.path, "README.md"), "# fixture\n\nworker\n");
    rmSync(join(tree.path, "notes.txt"));
    writeFileSync(join(tree.path, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
    mkdirSync(join(tree.path, "src"));
    writeFileSync(join(tree.path, "src", "a b.txt"), "one\ntwo\n");
    const { result, calls } = await traced(repo.dir, () => worktreeDiff(tree));
    expect(calls).toEqual([
      "git @<root>/.cheapag/worktrees/j1 check-ignore -q -- node_modules",
      "git @<root>/.cheapag/worktrees/j1 check-ignore -q -- packages/app/node_modules",
      "git @<root>/.cheapag/worktrees/j1 add -A -- . :(exclude,top,literal).cheapag :(exclude,top,literal)node_modules :(exclude,top,literal)packages/app/node_modules",
      "git @<root>/.cheapag/worktrees/j1 diff --cached --binary <sha>",
      "git @<root>/.cheapag/worktrees/j1 diff --cached --numstat -z --no-renames <sha>",
      "git @<root>/.cheapag/worktrees/j1 diff --cached --name-status -z --no-renames <sha>",
    ]);
    expect(result.changed).toEqual([
      { status: "M", path: "README.md", add: 1, del: 1 },
      { status: "A", path: "image.bin", add: 0, del: 0 },
      { status: "D", path: "notes.txt", add: 0, del: 1 },
      { status: "A", path: "src/a b.txt", add: 2, del: 0 },
    ]);
    // text hunks carry abbreviated blob ids, whose length depends on git's settings
    expect(result.patch).toMatch(
      /^diff --git a\/README\.md b\/README\.md\nindex [0-9a-f]+\.\.[0-9a-f]+ 100644\n--- a\/README\.md\n\+\+\+ b\/README\.md\n@@ -1,3 \+1,3 @@\n # fixture\n \n-edited\n\+worker\n/,
    );
    expect(result.patch).toContain("GIT binary patch");
    expect(result.patch).not.toContain("node_modules");
  },
);

posix(
  "land: git commands and file writes in order; the patch reaches the working tree, the developer's index and untracked files stay as they were",
  async () => {
    const repo = workingRepo();
    writeFileSync(repo.inRepo("staged.txt"), "staged\n");
    repo.git("add", "staged.txt");
    const job = workerChanges(repo, "j1");
    const indexBefore = repo.git("ls-files", "-s");
    const paths = job.changed.map((file) => file.path);
    expect(paths).toEqual(["README.md", "notes.txt", "src/new.txt"]);
    const { result, calls } = await traced(repo.dir, () => land(repo.dir, "j1", job.patch, paths));
    expect(result).toBeUndefined();
    expect(calls).toEqual([
      "mkdirSync <root>/.cheapag",
      "writeFileSync <root>/.cheapag/land.lock.<mine>",
      "linkSync <root>/.cheapag/land.lock.<mine> <root>/.cheapag/land.lock",
      "rmSync <root>/.cheapag/land.lock.<mine>",
      "git @<root> rev-parse --path-format=absolute --git-path index",
      "copyFileSync <root>/.git/index <root>/.cheapag/jobs/j1/land.index",
      "git @<root> ls-files -z -- :(literal)README.md :(literal)notes.txt :(literal)src/new.txt [index <root>/.cheapag/jobs/j1/land.index]",
      "git @<root> add -A -- :(literal)README.md :(literal)notes.txt [index <root>/.cheapag/jobs/j1/land.index]",
      "git @<root> apply --3way --check - [index <root>/.cheapag/jobs/j1/land.index]",
      "git @<root> apply --3way - [index <root>/.cheapag/jobs/j1/land.index]",
      "rmSync <root>/.cheapag/jobs/j1/land.index",
      "rmSync <root>/.cheapag/land.lock",
    ]);
    expect(readFileSync(repo.inRepo("README.md"), "utf8")).toBe("# fixture\n\nedited\nworker\n");
    expect(readFileSync(repo.inRepo("notes.txt"), "utf8")).toBe("untracked\nworker\n");
    expect(readFileSync(repo.inRepo("src", "new.txt"), "utf8")).toBe("new\n");
    expect(repo.git("ls-files", "-s")).toBe(indexBefore);
    expect(
      repo.git("status", "--porcelain", "--", "README.md", "staged.txt", "notes.txt", "src"),
    ).toBe(" M README.md\nA  staged.txt\n?? notes.txt\n?? src/\n");
    expect(readdirSync(repo.inRepo(".cheapag", "jobs", "j1"))).toEqual([]);
    expect(
      readdirSync(repo.inRepo(".cheapag")).filter((name) => name.startsWith("land.lock")),
    ).toEqual([]);
  },
);

posix(
  "land: a clash is returned as git's conflict text after the check alone; the tree and the index are untouched",
  async () => {
    const repo = workingRepo();
    const job = workerChanges(repo, "j1");
    writeFileSync(repo.inRepo("README.md"), "# fixture\n\nrewritten meanwhile\n");
    const indexBefore = repo.git("ls-files", "-s");
    const statusBefore = repo.git("status", "--porcelain", "--untracked-files=all");
    const paths = job.changed.map((file) => file.path);
    const { result, calls } = await traced(repo.dir, () => land(repo.dir, "j1", job.patch, paths));
    expect(result).toMatch(/with conflicts/);
    expect(conflictPaths(result ?? "")).toEqual(["README.md"]);
    expect(calls).toEqual([
      "mkdirSync <root>/.cheapag",
      "writeFileSync <root>/.cheapag/land.lock.<mine>",
      "linkSync <root>/.cheapag/land.lock.<mine> <root>/.cheapag/land.lock",
      "rmSync <root>/.cheapag/land.lock.<mine>",
      "git @<root> rev-parse --path-format=absolute --git-path index",
      "copyFileSync <root>/.git/index <root>/.cheapag/jobs/j1/land.index",
      "git @<root> ls-files -z -- :(literal)README.md :(literal)notes.txt :(literal)src/new.txt [index <root>/.cheapag/jobs/j1/land.index]",
      "git @<root> add -A -- :(literal)README.md :(literal)notes.txt [index <root>/.cheapag/jobs/j1/land.index]",
      "git @<root> apply --3way --check - [index <root>/.cheapag/jobs/j1/land.index]",
      "rmSync <root>/.cheapag/jobs/j1/land.index",
      "rmSync <root>/.cheapag/land.lock",
    ]);
    expect(readFileSync(repo.inRepo("README.md"), "utf8")).toBe(
      "# fixture\n\nrewritten meanwhile\n",
    );
    expect(readFileSync(repo.inRepo("notes.txt"), "utf8")).toBe("untracked\n");
    expect(existsSync(repo.inRepo("src"))).toBe(false);
    expect(repo.git("ls-files", "-s")).toBe(indexBefore);
    expect(repo.git("status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
    expect(readdirSync(repo.inRepo(".cheapag", "jobs", "j1"))).toEqual([]);
  },
);

posix("land: an empty patch takes and releases the lock and runs no git command", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const { result, calls } = await traced(repo.dir, () => land(repo.dir, "j1", " \n", ["a.txt"]));
  expect(result).toBeUndefined();
  expect(calls).toEqual([
    "mkdirSync <root>/.cheapag",
    "writeFileSync <root>/.cheapag/land.lock.<mine>",
    "linkSync <root>/.cheapag/land.lock.<mine> <root>/.cheapag/land.lock",
    "rmSync <root>/.cheapag/land.lock.<mine>",
    "rmSync <root>/.cheapag/land.lock",
  ]);
});

test("land: a job without its folder fails with the copy error, and the lock is released", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  await expect(land(repo.dir, "jnone", "diff\n", ["a.txt"])).rejects.toThrow(/ENOENT/);
  expect(readdirSync(join(repo.dir, ".cheapag"))).toEqual([]);
});

posix(
  "reapply leaves clashing hunks as markers in the fresh worktree and names them; leftoverMarkers finds them after worktreeDiff",
  async () => {
    const repo = workingRepo();
    const job = workerChanges(repo, "j1");
    writeFileSync(repo.inRepo("README.md"), "# fixture\n\nrewritten meanwhile\n");
    const redo = createWorktree(repo.dir, "j2", LINK_DIRS);
    const reapplied = await traced(repo.dir, () => reapply(redo, job.patch));
    expect(reapplied.result).toEqual(["README.md"]);
    expect(reapplied.calls).toEqual([
      "git @<root>/.cheapag/worktrees/j2 apply --3way -",
      "git @<root>/.cheapag/worktrees/j2 diff --name-only -z --diff-filter=U",
    ]);
    expect(readFileSync(join(redo.path, "README.md"), "utf8")).toMatch(/^<<<<<<< /m);
    expect(readFileSync(join(redo.path, "src", "new.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(repo.inRepo("README.md"), "utf8")).toBe(
      "# fixture\n\nrewritten meanwhile\n",
    );
    worktreeDiff(redo);
    const markers = await traced(repo.dir, () => leftoverMarkers(redo));
    expect(markers.result).toEqual(["README.md"]);
    expect(markers.calls).toEqual([
      "git @<root>/.cheapag/worktrees/j2 diff --cached --check <sha>",
    ]);
  },
);

posix("reapply: a patch that cannot apply at all leaves the worktree as it was", () => {
  const repo = workingRepo();
  const tree = createWorktree(repo.dir, "j1", LINK_DIRS);
  const statusBefore = execGit(tree.path, "status", "--porcelain");
  expect(reapply(tree, "not a patch\n")).toEqual([]);
  expect(execGit(tree.path, "status", "--porcelain")).toBe(statusBefore);
});

posix("removeWorktree unlinks the dependency links before git removes the worktree", async () => {
  const repo = workingRepo();
  const tree = createWorktree(repo.dir, "j1", LINK_DIRS);
  const { calls } = await traced(repo.dir, () => removeWorktree(repo.dir, tree));
  expect(calls).toEqual([
    "unlinkSync <root>/.cheapag/worktrees/j1/node_modules",
    "unlinkSync <root>/.cheapag/worktrees/j1/packages/app/node_modules",
    "git @<root> worktree remove --force <root>/.cheapag/worktrees/j1",
  ]);
  expect(existsSync(tree.path)).toBe(false);
  expect(worktrees(repo)).toBe(1);
  expect(readFileSync(repo.inRepo("node_modules", "dep", "index.js"), "utf8")).toBe("x\n");
  expect(readFileSync(repo.inRepo("packages", "app", "node_modules", "pkg.js"), "utf8")).toBe(
    "y\n",
  );
});

posix("jobWorktree: only a real directory, with the linkDirs that are links in it", () => {
  const repo = workingRepo();
  expect(jobWorktree(repo.dir, "j1", "tree", LINK_DIRS)).toBeUndefined();
  const tree = createWorktree(repo.dir, "j1", LINK_DIRS);
  expect(jobWorktree(repo.dir, "j1", "tree", LINK_DIRS)).toEqual({
    path: tree.path,
    head: "",
    stash: null,
    base: "tree",
    links: tree.links,
    linked: tree.linked,
  } satisfies Worktree);
  symlinkSync(tree.path, repo.inRepo(".cheapag", "worktrees", "jlink"));
  expect(jobWorktree(repo.dir, "jlink", "tree", LINK_DIRS)).toBeUndefined();
  writeFileSync(repo.inRepo(".cheapag", "worktrees", "jfile"), "");
  expect(jobWorktree(repo.dir, "jfile", "tree", LINK_DIRS)).toBeUndefined();
});

posix(
  "withLock: file writes in order, and a free lock runs fn before withLock returns",
  async () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    let ran = false;
    const { result, calls } = await traced(repo.dir, () => {
      const pending = withLock(repo.dir, () => {
        ran = true;
        return "done";
      });
      expect(ran).toBe(true);
      return pending;
    });
    expect(result).toBe("done");
    expect(calls).toEqual([
      "mkdirSync <root>/.cheapag",
      "writeFileSync <root>/.cheapag/land.lock.<mine>",
      "linkSync <root>/.cheapag/land.lock.<mine> <root>/.cheapag/land.lock",
      "rmSync <root>/.cheapag/land.lock.<mine>",
      "rmSync <root>/.cheapag/land.lock",
    ]);
  },
);

posix("withLock: a dead holder's lock is renamed away, removed, then taken", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  mkdirSync(join(repo.dir, ".cheapag"));
  const dead = { pid: 2 ** 22 + 12345, at: "2026-01-01T00:00:00.000Z", token: "dead" };
  writeFileSync(join(repo.dir, ".cheapag", "land.lock"), JSON.stringify(dead));
  const { calls } = await traced(repo.dir, () => withLock(repo.dir, () => "done"));
  expect(calls).toEqual([
    "mkdirSync <root>/.cheapag",
    "writeFileSync <root>/.cheapag/land.lock.<mine>",
    "linkSync <root>/.cheapag/land.lock.<mine> <root>/.cheapag/land.lock",
    "renameSync <root>/.cheapag/land.lock <root>/.cheapag/land.lock.<stale>",
    "rmSync <root>/.cheapag/land.lock.<stale>",
    "linkSync <root>/.cheapag/land.lock.<mine> <root>/.cheapag/land.lock",
    "rmSync <root>/.cheapag/land.lock.<mine>",
    "rmSync <root>/.cheapag/land.lock",
  ]);
});

test("withLock: fn's error is passed on and the lock released; a lock someone else holds by then is left alone", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const lock = join(repo.dir, ".cheapag", "land.lock");
  const failure = new TypeError("fn failed");
  await expect(
    withLock(repo.dir, () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(existsSync(lock)).toBe(false);
  const other = JSON.stringify({ pid: process.pid, at: "later", token: "other" });
  await withLock(repo.dir, () => writeFileSync(lock, other));
  expect(readFileSync(lock, "utf8")).toBe(other);
});

test.each([
  [undefined, "10 min"],
  ["0", "10 min"],
  ["not a number", "10 min"],
  ["90000", "2 min"],
  ["60000", "1 min"],
  ["59999", "59.999 s"],
])(
  "withLock: with CHEAPAG_LOCK_TIMEOUT_MS=%s a live holder times the wait out after %s",
  async (timeout, waited) => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    mkdirSync(join(repo.dir, ".cheapag"));
    const held = { pid: process.pid, at: "2026-11-26T00:00:00.000Z", token: "live" };
    writeFileSync(join(repo.dir, ".cheapag", "land.lock"), JSON.stringify(held));
    vi.stubEnv("CHEAPAG_LOCK_TIMEOUT_MS", timeout);
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });
    const ran = vi.fn();
    const failed = expect(withLock(repo.dir, ran)).rejects.toThrow(
      `timed out after ${waited} waiting for .cheapag/land.lock (held by pid ${process.pid} since 2026-11-26T00:00:00.000Z); try again once it is released`,
    );
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await failed;
    expect(ran).not.toHaveBeenCalled();
  },
);

test.each([
  [["MERGE_HEAD"], "a merge is in progress"],
  [["rebase-merge"], "a rebase is in progress"],
  [["rebase-apply"], "a rebase is in progress"],
  [["CHERRY_PICK_HEAD"], "a cherry-pick is in progress"],
  [["REVERT_HEAD"], "a revert is in progress"],
  [["REVERT_HEAD", "MERGE_HEAD"], "a merge is in progress"],
  [["CHERRY_PICK_HEAD", "rebase-apply"], "a rebase is in progress"],
  [[], undefined],
])("operationInProgress with %j in .git is %s", (markers, expected) => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  for (const marker of markers) writeFileSync(join(repo.dir, ".git", marker), "");
  expect(operationInProgress(repo.dir)).toBe(expected);
});

test("operationInProgress: unmerged paths without a marker are unresolved conflicts; a marker is named first", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  conflictingBranches(repo.dir, repo.git);
  expect(() => repo.git("merge", "-q", "side")).toThrow();
  expect(operationInProgress(repo.dir)).toBe("a merge is in progress");
  rmSync(join(repo.dir, ".git", "MERGE_HEAD"));
  expect(operationInProgress(repo.dir)).toBe("there are unresolved conflicts");
});

posix(
  "operationInProgress: one git-path lookup per marker in order, then the unmerged check",
  async () => {
    const repo = tempRepo();
    onTestFinished(repo.cleanup);
    expect((await traced(repo.dir, () => operationInProgress(repo.dir))).calls).toEqual([
      "git @<root> rev-parse --path-format=absolute --git-path MERGE_HEAD",
      "git @<root> rev-parse --path-format=absolute --git-path rebase-merge",
      "git @<root> rev-parse --path-format=absolute --git-path rebase-apply",
      "git @<root> rev-parse --path-format=absolute --git-path CHERRY_PICK_HEAD",
      "git @<root> rev-parse --path-format=absolute --git-path REVERT_HEAD",
      "git @<root> ls-files --unmerged",
    ]);
    writeFileSync(join(repo.dir, ".git", "rebase-apply"), "");
    expect((await traced(repo.dir, () => operationInProgress(repo.dir))).calls).toEqual([
      "git @<root> rev-parse --path-format=absolute --git-path MERGE_HEAD",
      "git @<root> rev-parse --path-format=absolute --git-path rebase-merge",
      "git @<root> rev-parse --path-format=absolute --git-path rebase-apply",
    ]);
  },
);

posix("git, projectRoot, callRoot and hasCommits: their git commands", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const nested = join(repo.dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  const { calls } = await traced(repo.dir, () => [
    git(repo.dir, ["rev-parse", "--git-path", "index"]),
    git(repo.dir, ["rev-parse", "--git-path", "index"], { GIT_INDEX_FILE: "/elsewhere/index" }),
    projectRoot(nested),
    callRoot(nested),
    hasCommits(repo.dir),
  ]);
  expect(calls).toEqual([
    "git @<root> rev-parse --git-path index",
    "git @<root> rev-parse --git-path index [index /elsewhere/index]",
    "git @<root>/a/b rev-parse --show-toplevel",
    "git @<root>/a/b rev-parse --show-toplevel",
    "git @<root> rev-parse --verify --quiet HEAD",
  ]);
});

test("git returns raw stdout and passes env on top of the process's own", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  expect(git(repo.dir, ["rev-parse", "--git-path", "index"])).toBe(".git/index\n");
  vi.stubEnv("CHEAPAG_TEST_INHERITED", "inherited");
  onTestFinished(() => void vi.unstubAllEnvs());
  const script = 'printf "%s %s" "$CHEAPAG_TEST_INHERITED" "$CHEAPAG_TEST_GIVEN"';
  expect(
    git(repo.dir, ["-c", `alias.both=!${script}`, "both"], { CHEAPAG_TEST_GIVEN: "given" }),
  ).toBe("inherited given");
});

test("projectRoot and callRoot: the repository root from a nested folder, and their errors", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const nested = join(repo.dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  expect(projectRoot(nested)).toBe(repo.dir);
  expect(callRoot(nested)).toBe(repo.dir);
  vi.spyOn(process, "cwd").mockReturnValue(nested);
  onTestFinished(() => void vi.restoreAllMocks());
  expect(callRoot()).toBe(repo.dir);
  expect(callRoot(undefined)).toBe(repo.dir);
  expect(() => callRoot("a/b")).toThrow(new Error("root a/b must be an absolute path"));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-no-repo-")));
  onTestFinished(() => removeDir(outside));
  expect(() => projectRoot(outside)).toThrow(
    new Error(`${outside} is not inside a git repository`),
  );
  expect(() => callRoot(outside)).toThrow(new Error(`${outside} is not inside a git repository`));
});

test("hasCommits is false for a fresh git init and true once there is a commit", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-test-")));
  onTestFinished(() => removeDir(dir));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  expect(hasCommits(dir)).toBe(false);
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  expect(hasCommits(repo.dir)).toBe(true);
});

test("conflictPaths names each path git apply reports, once, in first-seen order", () => {
  const text = [
    "error: patch failed: skipped.txt:1",
    "Falling back to three-way merge...",
    "Applied patch to 'a b.txt' with conflicts.",
    "U a b.txt",
    "error: gone.txt: does not exist in index",
    "error: changed.txt: does not match index",
    "error: indexed.txt: already exists in index",
    "error: present.txt: already exists in working directory",
    "error: odd: name.txt: patch does not apply",
    "Applied patch to 'a b.txt' with conflicts.",
    "error: gone.txt: does not exist in index",
    "  error: indented.txt: patch does not apply",
    "error: trailing.txt: patch does not apply.",
  ].join("\n");
  expect(conflictPaths(text)).toEqual([
    "a b.txt",
    "gone.txt",
    "changed.txt",
    "indexed.txt",
    "present.txt",
    "odd: name.txt",
  ]);
  expect(conflictPaths("")).toEqual([]);
});
