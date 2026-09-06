import { describe, expect, it } from "vite-plus/test";

import { formatProviderReset } from "./providerResetDisplay";

describe("formatProviderReset", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);

  it("formats countdowns with useful day, hour and minute precision", () => {
    expect(formatProviderReset(now + ((4 * 24 + 12) * 60 + 7) * 60_000, "countdown", now)).toBe(
      "Resets in 4d 12h",
    );
    expect(formatProviderReset(now + (7 * 60 + 24) * 60_000, "countdown", now)).toBe(
      "Resets in 7h 24m",
    );
    expect(formatProviderReset(now + 42 * 60_000, "countdown", now)).toBe("Resets in 42m");
  });

  it("rounds a partial final minute up and marks elapsed resets as due", () => {
    expect(formatProviderReset(now + 1_000, "countdown", now)).toBe("Resets in 1m");
    expect(formatProviderReset(now, "countdown", now)).toBe("Reset due");
  });

  it("keeps the existing localized absolute date mode", () => {
    expect(formatProviderReset(now + 60_000, "date", now)).toMatch(/^Resets /);
    expect(formatProviderReset(undefined, "countdown", now)).toBe("Reset unknown");
  });
});
