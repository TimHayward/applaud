import { describe, it, expect } from "vitest";
import { toastDurationMs } from "./toastDuration.js";

describe("toastDurationMs", () => {
  it("uses the short default for success and info", () => {
    expect(toastDurationMs("success", "Settings saved.")).toBe(5_000);
    expect(toastDurationMs("info", "Sync started.")).toBe(5_000);
  });

  it("keeps the default for a long success message too (it's expected text)", () => {
    expect(toastDurationMs("success", "x".repeat(300))).toBe(5_000);
  });

  it("gives a short error more than the 5s the old fixed timeout allowed", () => {
    const ms = toastDurationMs("error", "Request failed.");
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(5_000);
  });

  it("scales with message length", () => {
    const short = toastDurationMs("error", "Nope.")!;
    const longer = toastDurationMs("error", "Nope, that request failed for a reason.")!;
    expect(longer).toBeGreaterThan(short);
  });

  it("caps the auto-dismiss delay", () => {
    expect(toastDurationMs("error", "x".repeat(159))!).toBeLessThanOrEqual(20_000);
  });

  it("never auto-dismisses a paragraph-length error", () => {
    expect(toastDurationMs("error", "x".repeat(161))).toBeNull();
  });

  it("still auto-dismisses an error right at the sticky threshold", () => {
    expect(toastDurationMs("error", "x".repeat(160))).not.toBeNull();
  });
});
