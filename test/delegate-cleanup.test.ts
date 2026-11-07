import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import * as consent from "../src/consent.js";
import { delegate } from "../src/jobs.js";
import * as routing from "../src/routing.js";
import * as workspace from "../src/workspace.js";
import { startFakeOpencode } from "./fake-opencode.js";
import { tempRepo } from "./harness.js";

/** In-process, so removing the worktree can fail the way Windows makes it fail when something still holds the folder open. */
test("a landed job whose worktree can't be removed stays OK, landed, with the cleanup error on its record and block", async () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  onTestFinished(() => { vi.restoreAllMocks(); });
  vi.spyOn(workspace, "projectRoot").mockReturnValue(repo.dir);
  vi.spyOn(consent, "consentGate").mockReturnValue({ route: routing.fullRoute("opencode-go") });
  vi.spyOn(routing, "recordSpend").mockImplementation(() => {});
  const fake = await startFakeOpencode();
  onTestFinished(fake.close);
  fake.script(
    { edit: "src/kept.ts", content: "export const kept = 1;\n" },
    { tool: "write" },
    { finish: { summary: "added kept", risks: [], review: [], missing: [] } },
  );
  const locked = Object.assign(new Error("EPERM, Permission denied: .cheapag/worktrees/jxxxx"), { code: "EPERM" });
  const removeWorktree = vi.spyOn(workspace, "removeWorktree").mockImplementation(() => {
    throw locked;
  });

  const text = await delegate({ task: "Add src/kept.ts exporting kept = 1", files: "src/kept.ts", done_when: "kept is exported" }, {
    provider: { provider: "opencode-go", via: "login" },
    opencode: async () => ({ url: fake.url, password: "unused", version: "test" }),
    progress: () => {},
  });

  const job = text.match(/^\w+ (j[0-9a-z]{4}) /)![1];
  expect(text.split("\n")[0]).toMatch(new RegExp(`^OK ${job} step=1 `));
  expect(text).toContain(`cleanup error: ${locked.message} (the change landed; only its worktree folder was left behind)`);
  expect(text).not.toContain("reason:");
  expect(removeWorktree).toHaveBeenCalledOnce();
  expect(readFileSync(join(repo.dir, "src", "kept.ts"), "utf8").replace(/\r\n/g, "\n")).toBe("export const kept = 1;\n");
  const record = JSON.parse(readFileSync(join(repo.dir, ".cheapag", "jobs", job, "result.json"), "utf8"));
  expect(record).toMatchObject({ status: "OK", landed: true, cleanupError: locked.message, worktree: null });
});
