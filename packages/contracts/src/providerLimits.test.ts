import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderLimitsState, ProviderLimitsSnapshot } from "./providerLimits.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ProviderLimitsSnapshot);
const decodeState = Schema.decodeUnknownSync(ProviderLimitsState);

describe("ProviderLimitsSnapshot", () => {
  it("requires the provider, buckets, capture metadata and warnings", () => {
    expect(() => decodeSnapshot({})).toThrow();
  });

  it("rejects non-numeric utilization", () => {
    expect(() =>
      decodeSnapshot({
        provider: "claude",
        capturedAt: 1,
        source: "read",
        authState: "ok",
        parseWarnings: [],
        buckets: [
          {
            bucketId: "five_hour",
            displayName: "5-hour",
            kind: "session",
            primary: { label: "5h", usedPercent: "62" },
          },
        ],
      }),
    ).toThrow();
  });

  it("decodes a live subscription snapshot without historical cost data", () => {
    const decoded = decodeSnapshot({
      provider: "claude",
      capturedAt: 1_786_000_000_000,
      source: "read",
      authState: "ok",
      planType: "max",
      parseWarnings: [],
      buckets: [
        {
          bucketId: "five_hour",
          displayName: "5-hour",
          kind: "session",
          primary: {
            label: "5h",
            usedPercent: 62,
            resetsAt: 1_786_010_000_000,
            windowDurationMins: 300,
          },
        },
      ],
    });

    expect(decoded.buckets[0]?.primary.usedPercent).toBe(62);
    expect(decoded).not.toHaveProperty("costUsd");
  });

  it("keeps unknown buckets and ignores additive provider fields", () => {
    const decoded = decodeSnapshot({
      provider: "codex",
      capturedAt: 1_786_000_000_000,
      source: "event",
      authState: "ok",
      parseWarnings: ["Unknown Codex bucket: experimental"],
      buckets: [
        {
          bucketId: "experimental",
          displayName: "Experimental",
          kind: "unknown",
          primary: { label: "Primary", usedPercent: 17 },
          providerSpecificFutureField: true,
        },
      ],
      providerSpecificFutureField: "ignored",
    });

    expect(decoded.buckets[0]?.kind).toBe("unknown");
    expect(decoded.parseWarnings).toEqual(["Unknown Codex bucket: experimental"]);
  });
});

describe("ProviderLimitsState", () => {
  it("captures the actual route and the originally requested provider", () => {
    const decoded = decodeState({
      lastActualRoute: {
        provider: "codex",
        requestedProvider: "claude",
        model: "gpt-5.6-sol",
        at: 1_786_000_000_000,
        fallback: true,
        statusCode: 200,
      },
    });

    expect(decoded.lastActualRoute?.fallback).toBe(true);
    expect(decoded.lastActualRoute?.requestedProvider).toBe("claude");
  });
});

describe("provider limit RPC names", () => {
  it("exposes environment-scoped subscribe and refresh methods", () => {
    expect(WS_METHODS.subscribeProviderLimits).toBe("subscribeProviderLimits");
    expect(WS_METHODS.serverRefreshProviderLimits).toBe("server.refreshProviderLimits");
  });
});
