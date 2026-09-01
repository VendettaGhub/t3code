import { describe, expect, it } from "vite-plus/test";

import type { ProviderLimitsSnapshot } from "@t3tools/contracts";
import {
  chipState,
  headlineCode,
  resolveEmphasis,
  routeForModel,
  selectHeadlineBucket,
} from "./ProviderLimitChips.logic.ts";

const snapshot = (overrides: Partial<ProviderLimitsSnapshot> = {}): ProviderLimitsSnapshot => ({
  provider: "claude",
  capturedAt: 1_000,
  source: "read",
  authState: "ok",
  parseWarnings: [],
  buckets: [
    {
      bucketId: "five_hour",
      displayName: "5-hour",
      kind: "session",
      primary: { label: "5h", usedPercent: 62, resetsAt: 5_000 },
    },
    {
      bucketId: "weekly",
      displayName: "Weekly",
      kind: "weekly",
      primary: { label: "Week", usedPercent: 58, resetsAt: 10_000 },
    },
  ],
  ...overrides,
});

describe("selectHeadlineBucket", () => {
  it("selects the most-used normal Codex window and ignores Spark", () => {
    const selected = selectHeadlineBucket(
      snapshot({
        buckets: [
          {
            bucketId: "codex",
            displayName: "Codex",
            kind: "session",
            primary: { label: "5h", usedPercent: 45, resetsAt: 5_000 },
            secondary: { label: "Week", usedPercent: 77, resetsAt: 10_000 },
          },
        ],
      }),
      2_000,
    );
    expect(selected).toMatchObject({ label: "Week", usedPercent: 77 });
  });

  it("selects the highest Claude window across 5h, Fable and all models", () => {
    const selected = selectHeadlineBucket(
      snapshot({
        buckets: [
          {
            bucketId: "five_hour",
            displayName: "5-hour",
            kind: "session",
            primary: { label: "5h", usedPercent: 62, resetsAt: 5_000 },
          },
          {
            bucketId: "seven_day",
            displayName: "Weekly",
            kind: "weekly",
            primary: { label: "Week", usedPercent: 71, resetsAt: 10_000 },
          },
          {
            bucketId: "seven_day_scoped:claude-fable-5",
            displayName: "Claude Fable 5 weekly",
            kind: "model-weekly",
            primary: { label: "Week", usedPercent: 87, resetsAt: 10_000 },
          },
        ],
      }),
      2_000,
    );

    expect(selected).toMatchObject({
      bucket: { bucketId: "seven_day_scoped:claude-fable-5" },
      usedPercent: 87,
    });
    expect(selected && headlineCode("claude", selected)).toBe("F");
  });

  it("labels Claude all-model weekly and Codex weekly windows distinctly", () => {
    const all = selectHeadlineBucket(snapshot(), 7_000);
    const codex = selectHeadlineBucket(snapshot({ provider: "codex" }), 7_000);

    expect(all && headlineCode("claude", all)).toBe("A");
    expect(codex && headlineCode("codex", codex)).toBe("W");
  });

  it("does not let a Spark-only bucket dominate the normal Codex headline", () => {
    const selected = selectHeadlineBucket(
      snapshot({
        provider: "codex",
        buckets: [
          {
            bucketId: "codex",
            displayName: "Codex",
            kind: "weekly",
            primary: { label: "Week", usedPercent: 72, resetsAt: 10_000 },
          },
          {
            bucketId: "spark",
            displayName: "GPT-5.3-Codex-Spark",
            kind: "named",
            primary: { label: "5h", usedPercent: 100, resetsAt: 5_000 },
            secondary: { label: "Week", usedPercent: 89, resetsAt: 10_000 },
          },
        ],
      }),
      2_000,
    );

    expect(selected).toMatchObject({
      bucket: { bucketId: "codex" },
      label: "Week",
      usedPercent: 72,
    });
  });

  it("does not choose an already reset window", () => {
    const selected = selectHeadlineBucket(snapshot(), 7_000);
    expect(selected).toMatchObject({ label: "Week", usedPercent: 58 });
  });
});

describe("routeForModel", () => {
  it.each([
    ["claude-fable-5[effort=high]", "claude"],
    ["claude-opus-5[1m]", "claude"],
    ["anthropic/gpt-5.6-sol[effort=xhigh][fast=true]", "codex"],
    ["claude-haiku-4-5[1m][effort=max]", "codex"],
    ["qwen3.8-27b", "local"],
  ] as const)("maps %s to %s", (model, route) => {
    expect(routeForModel(model)).toBe(route);
  });
});

describe("resolveEmphasis", () => {
  it("uses the picker route before the active turn has an audited result", () => {
    expect(resolveEmphasis("claude", undefined, 1_000)).toBe("claude");
  });

  it("uses a newer actual fallback route", () => {
    expect(
      resolveEmphasis(
        "claude",
        {
          provider: "codex",
          requestedProvider: "claude",
          model: "gpt-5.6-sol",
          at: 2_000,
          fallback: true,
          statusCode: 200,
        },
        1_000,
      ),
    ).toBe("codex");
  });

  it("never emphasizes a subscription chip for Qwen", () => {
    expect(resolveEmphasis("local", undefined, 1_000)).toBeNull();
  });
});

describe("chipState", () => {
  it("distinguishes ok, stale, unauthenticated and unavailable states", () => {
    expect(chipState(snapshot(), 5_000, 10_000).kind).toBe("ok");
    expect(chipState(snapshot(), 20_000, 10_000).kind).toBe("stale");
    expect(
      chipState(snapshot({ authState: "unauthenticated" }), 5_000, 10_000).kind,
    ).toBe("unauthenticated");
    expect(chipState(undefined, 5_000, 10_000).kind).toBe("unavailable");
  });
});
