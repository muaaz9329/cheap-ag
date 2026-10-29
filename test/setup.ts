import { vi } from "vitest";

// Windows CI runs ~3x slower; vi.waitFor's 1000 ms default is too short there.
if (process.platform === "win32") {
  const waitFor = vi.waitFor;
  vi.waitFor = (callback, options) =>
    waitFor(callback, {
      ...(typeof options === "object" ? options : {}),
      timeout: (typeof options === "number" ? options : options?.timeout ?? 1000) * 3,
    });
}
