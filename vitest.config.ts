import { defineConfig } from "vitest/config";

// only this checkout's tests: agent worktrees under .claude/ hold copies of the suite
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Windows is slower and holds file locks briefly
    ...(process.platform === "win32" ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
  },
});
