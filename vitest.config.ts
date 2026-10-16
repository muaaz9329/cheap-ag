import { defineConfig } from "vitest/config";

// only this checkout's tests: agent worktrees under .claude/ hold copies of the suite
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
