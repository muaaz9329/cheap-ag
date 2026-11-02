import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The worker's permission ruleset (spec E1, A12). Verified against OpenCode 1.19.0 with a scripted model:
 * - rules passed to `session.create` are enforced, the last matching rule winning; an agent file's `permission:`
 *   frontmatter is NOT applied, so the ruleset goes on every worker session;
 * - `OPENCODE_PERMISSION` (the server-wide baseline) applies too, but a session rule overrides it, so the session
 *   ruleset itself ends with the hard denylist;
 * - edit patterns are worktree-relative and cannot deny an absolute path outside it, so `external_directory` stays
 *   denied: linked dependency dirs are read through their in-worktree symlink, and edits under them are denied.
 * - OpenCode splits `;`, `|`, `&&`, `$(…)` and backticks into separate checked commands, but not redirection, so
 *   `>` is denied outright.
 *
 * This is a guardrail against commands the model types, not a sandbox: the worker can edit source and run allowed
 * test commands, so code it writes can still run anything the developer's user can (see STATUS carry-forward).
 */

export type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/** Commands no project script or config may allow: always the last rules, so they always win. */
export const HARD_DENY = [
  ...PACKAGE_MANAGERS.flatMap((pm) => [`${pm} install*`, `${pm} i`, `${pm} i *`, `${pm} add*`, `${pm} ci*`]),
  "pip install*", "pip3 install*", "python -m pip install*", "python3 -m pip install*", "uv add*", "uv pip install*",
  "go get*", "go install*", "cargo add*", "cargo install*", "brew *",
  ...["commit", "push", "reset", "checkout", "switch", "rebase", "merge", "stash", "clean"].map((verb) => `git ${verb}*`),
  "rm -rf*", "rm -fr*", "sudo*", "curl*", "wget*", "ssh*", "scp*", "npm publish*", "chmod -R*",
  // seen bypassing allowed prefixes against the real OpenCode: writes past the edit rules, or arbitrary programs
  "*>*", "git *--output*", "git *--ext-diff*", "go test*-exec*", "go test*-toolexec*", "cargo test*--config*",
  "npm exec*", "pnpm dlx*", "yarn dlx*", "bunx*",
  // bash segments naming a .env file (the read tool's deny does not cover bash) and rg flags that read gitignored files
  "* .env*", "*/.env*", "rg*--no-ignore*", "rg* -u*",
];

const LOCKFILES = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "go.sum",
];

/** Paths the worker may never edit: git internals, Cheap Agent state, env files, lockfiles. */
export const PROTECTED = [
  ".git", ".git/**", "**/.git", "**/.git/**", ".cheapag/**", ".env*", "**/.env*",
  // the worker must not loosen its own (or a later job's) rules
  "cheapag.json",
  ...LOCKFILES.flatMap((f) => [f, `**/${f}`]),
];

/** Always-allowed commands, each as typed and with arguments: read-only basics, git, and the common test runners. */
const ALWAYS = [
  "ls", "pwd", "cat", "head", "tail", "wc", "node --version", "node -v",
  "git status", "git diff", "git log", "git show",
  "git -C * diff", "git -C * status", "git -C * log", "git -C * show",
  "git --no-pager diff", "git --no-pager status", "git --no-pager log", "git --no-pager show",
  "rg", "npx eslint", "npx tsc", "npx prettier", "pytest", "python -m pytest", "python3 -m pytest", "go test", "cargo test", "bun test",
];

const allow = (permission: string, pattern = "*"): Rule => ({ permission, pattern, action: "allow" });
const deny = (permission: string, pattern = "*"): Rule => ({ permission, pattern, action: "deny" });
/** A command allowed as typed, and with any arguments after it. */
const command = (cmd: string) => [allow("bash", cmd), allow("bash", `${cmd} *`)];

/** Secrets: OpenCode's default does not cover .env reads under these rulesets; examples stay readable (last match wins). */
const ENV_READS = [
  ...[".env*", "**/.env*"].map((p) => deny("read", p)),
  ...[".env.example", "**/.env.example", ".env.sample", "**/.env.sample"].map((p) => allow("read", p)),
];

/**
 * The full ruleset for one worker session: catch-all deny first, then explicit allows and denies for every key,
 * then the hard denylist. `scripts` and `allowCommands` are allowed with any arguments; `exact` only as written
 * (make targets, the step's done-when checks); `linked` are dependency dirs in the worktree (readable, never editable).
 */
export function workerRuleset(opts: { scripts?: string[]; exact?: string[]; allowCommands?: string[]; linked?: string[] } = {}): Rule[] {
  return [
    deny("*"),
    // `finish` is Cheap Agent's own tool (tools/finish.ts): custom tools are permission-checked by name, so the
    // catch-all would otherwise hide it from the worker
    ...["read", "glob", "grep", "list", "lsp", "todowrite", "question", "finish"].map((p) => allow(p)),
    ...ENV_READS,
    ...["external_directory", "webfetch", "websearch", "task", "skill", "doom_loop"].map((p) => deny(p)),
    allow("edit"),
    ...PROTECTED.map((p) => deny("edit", p)),
    ...(opts.linked ?? []).flatMap((d) => [deny("edit", d), deny("edit", `${d}/**`)]),
    deny("bash"),
    ...[...ALWAYS, ...(opts.scripts ?? []), ...(opts.allowCommands ?? [])].flatMap(command),
    ...(opts.exact ?? []).map((c) => allow("bash", c)),
    ...HARD_DENY.map((p) => deny("bash", p)),
  ];
}

/**
 * The research worker's ruleset (spec E1, research; ticket 23.4): read, search, and run the same test commands as the
 * implementation worker (to reproduce a failure it is asked about), never edit. It runs in a throwaway worktree (src/research.ts),
 * so a command that writes files cannot touch the developer's tree. Env files are unreadable; outside the repo is denied.
 */
export function researchRuleset(opts: { scripts?: string[]; exact?: string[]; allowCommands?: string[] } = {}): Rule[] {
  return [
    deny("*"),
    ...["read", "glob", "grep", "list"].map((p) => allow(p)),
    ...ENV_READS,
    ...["edit", "question", "lsp", "todowrite", "finish", "external_directory", "webfetch", "websearch", "task", "skill", "doom_loop"].map((p) => deny(p)),
    deny("bash"),
    ...[...ALWAYS, ...(opts.scripts ?? []), ...(opts.allowCommands ?? [])].flatMap(command),
    ...(opts.exact ?? []).map((c) => allow("bash", c)),
    ...HARD_DENY.map((p) => deny("bash", p)),
  ];
}

/** The same static rules in OpenCode's config form, for the server-wide `OPENCODE_PERMISSION` baseline. */
export function baselinePermission() {
  const config: Record<string, string | Record<string, string>> = {};
  for (const rule of workerRuleset()) {
    if (rule.pattern === "*" && !(rule.permission in config)) config[rule.permission] = rule.action;
    else {
      const current = config[rule.permission];
      config[rule.permission] = { ...(typeof current === "string" ? { "*": current } : current), [rule.pattern]: rule.action };
    }
  }
  return config;
}

/**
 * The project's own runnable scripts: package.json scripts under each package manager (`scripts`, arguments allowed)
 * and make targets (`exact`: `make -f`/`--eval` would run anything). Names with spaces or wildcards are skipped.
 */
export function projectScripts(dir: string): { scripts: string[]; exact: string[] } {
  const commands: string[] = [];
  const exact: string[] = [];
  const plain = (name: string) => /^[\w:@./-]+$/.test(name);
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const scripts = Object.keys((JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}).filter(plain);
      for (const s of scripts) commands.push(...PACKAGE_MANAGERS.map((pm) => `${pm} run ${s}`), `yarn ${s}`);
      if (scripts.includes("test")) commands.push("npm test", "npm t", "pnpm test", "yarn test", "bun run test");
    } catch {
      // an unreadable package.json contributes no scripts
    }
  }
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    if (!existsSync(join(dir, name))) continue;
    const targets = readFileSync(join(dir, name), "utf8").matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm);
    for (const [, target] of targets) if (plain(target)) exact.push(`make ${target}`);
    exact.push("make");
  }
  return { scripts: [...new Set(commands)], exact: [...new Set(exact)] };
}

/** What a worker sees when a permission request is auto-rejected (spec E1). */
export const rejectionMessage = (what: string) =>
  `Not allowed in cheapag: \`${what}\`. If you need a dependency, use the question tool. Otherwise finish and list it in risks.`;
