import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { negotiateUsageSummary } from "./usageCompatibility.ts";

function summary(): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-08-29T20:00:00.000Z",
    timeZone: "Europe/Berlin",
    sinceDay: "2026-08-29" as UsageDay,
    untilDay: "2026-08-29" as UsageDay,
    buckets: [
      {
        day: "2026-08-29" as UsageDay,
        provider: "claude",
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 20,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
        },
        costUsd: 1,
        cacheSavingsUsd: 0.2,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
      {
        day: "2026-08-29" as UsageDay,
        provider: "grok",
        model: "grok-code-fast-1",
        totals: {
          uncachedInputTokens: 30,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        costUsd: 2,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: ["claude", "grok"].map((provider) => ({
      fingerprint: {
        hostId: "hannes-pc",
        provider: provider as "claude" | "grok",
        resolvedHomePath: `C:/${provider}`,
        volumeId: `volume-${provider}`,
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 2 },
    scanDurationMs: 10,
  };
}

describe("negotiateUsageSummary", () => {
  it("returns a v4-decodable Claude/Codex response when an older client sends no capability", () => {
    const compatible = negotiateUsageSummary(summary(), undefined);

    expect(compatible.contractVersion).toBe(USAGE_MERGE_COMPATIBLE_SINCE);
    expect(compatible.buckets.map((bucket) => bucket.provider)).toEqual(["claude"]);
    expect(compatible.sources.map((source) => source.fingerprint.provider)).toEqual(["claude"]);
  });

  it("keeps the complete v5 response when the client requests the current contract", () => {
    const current = negotiateUsageSummary(summary(), USAGE_CONTRACT_VERSION);

    expect(current.contractVersion).toBe(USAGE_CONTRACT_VERSION);
    expect(current.buckets.map((bucket) => bucket.provider)).toEqual(["claude", "grok"]);
    expect(current.sources.map((source) => source.fingerprint.provider)).toEqual([
      "claude",
      "grok",
    ]);
  });
});
