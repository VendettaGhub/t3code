import { describe, expect, it } from "vite-plus/test";

import {
  consumeHybridAuditRecord,
  createHybridAuditState,
  mergeCodexRateLimits,
  mergeProviderSnapshot,
  normalizeClaudeLimits,
  normalizeCodexLimits,
} from "./ProviderLimitsService.ts";

describe("Codex subscription limits", () => {
  it("preserves baseline metadata while applying sparse rolling windows", () => {
    const baseline = {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        planType: "plus",
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_786_000_000 },
        secondary: { usedPercent: 40, windowDurationMins: 10_080 },
      },
    };
    const update = {
      rateLimits: {
        planType: null,
        limitName: null,
        primary: { usedPercent: 33, windowDurationMins: null, resetsAt: null },
      },
    };

    const merged = mergeCodexRateLimits(baseline, update);
    expect(merged.rateLimits).toMatchObject({
      limitName: "Codex",
      planType: "plus",
      primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1_786_000_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080 },
    });
  });

  it("normalizes the default and named Spark buckets", () => {
    const snapshot = normalizeCodexLimits(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          planType: "plus",
          primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_786_000_000 },
          secondary: { usedPercent: 51, windowDurationMins: 10_080 },
        },
        rateLimitsByLimitId: {
          spark: {
            limitId: "spark",
            limitName: "Spark",
            primary: { usedPercent: 73, windowDurationMins: 10_080 },
          },
        },
      },
      1_786_000_000_000,
      "read",
    );

    expect(snapshot.planType).toBe("plus");
    expect(snapshot.buckets.map((bucket) => [bucket.bucketId, bucket.displayName])).toEqual([
      ["codex", "Codex"],
      ["spark", "Spark"],
    ]);
    expect(snapshot.buckets[0]?.primary.resetsAt).toBe(1_786_000_000_000);
    expect(snapshot.buckets[1]?.kind).toBe("named");
  });
});

describe("Claude subscription limits", () => {
  it("normalizes the SDK on-demand usage response", () => {
    const snapshot = normalizeClaudeLimits(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-08-29T20:00:00.000Z" },
          seven_day: { utilization: 58, resets_at: "2026-09-03T00:00:00.000Z" },
          seven_day_opus: { utilization: 71, resets_at: null },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 100,
            used_credits: 25,
            utilization: 25,
            currency: "USD",
          },
        },
      },
      1_786_000_000_000,
      "read",
    );

    expect(snapshot.authState).toBe("ok");
    expect(snapshot.planType).toBe("max");
    expect(snapshot.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "extra_usage",
    ]);
    expect(snapshot.buckets.at(-1)?.spend).toMatchObject({ used: 25, limit: 100, currency: "USD" });
  });

  it("keeps experimental buckets with a warning instead of throwing", () => {
    const snapshot = normalizeClaudeLimits(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          rolling_30_day: { utilization: 12, resets_at: "not-a-date" },
        },
      },
      1_786_000_000_000,
      "read",
    );

    expect(snapshot.buckets[0]).toMatchObject({
      bucketId: "rolling_30_day",
      displayName: "rolling 30 day",
      kind: "unknown",
    });
    expect(snapshot.parseWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rolling_30_day"),
        expect.stringContaining("reset"),
      ]),
    );
  });

  it("normalizes current limits and minor-unit spend without exposing response metadata", () => {
    const snapshot = normalizeClaudeLimits(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          limits: [
            {
              kind: "session",
              group: "session",
              percent: 87,
              resets_at: "2026-08-29T20:10:00.000Z",
              scope: null,
              is_active: true,
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: 21,
              resets_at: "2026-09-05T05:00:00.000Z",
              scope: null,
              is_active: false,
            },
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 9,
              resets_at: null,
              scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
              is_active: false,
            },
          ],
          spend: {
            used: { amount_minor: 2_478, currency: "EUR", exponent: 2 },
            limit: { amount_minor: 20_000, currency: "EUR", exponent: 2 },
            percent: 12,
            severity: "ok",
            enabled: true,
          },
          nimbus_quill: { enabled: false },
          member_dashboard_available: true,
          model_scoped: {
            enabled: true,
            model: { id: "claude-fable-5", display_name: "Fable" },
          },
        },
      },
      1_786_000_000_000,
      "read",
    );

    expect(snapshot.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_scoped:claude-fable-5",
      "extra_usage",
    ]);
    expect(snapshot.buckets[0]).toMatchObject({
      displayName: "5-hour",
      kind: "session",
      primary: { label: "5h", usedPercent: 87, windowDurationMins: 300 },
    });
    expect(snapshot.buckets[2]).toMatchObject({
      displayName: "Fable weekly",
      kind: "model-weekly",
      primary: { label: "Fable", usedPercent: 9, windowDurationMins: 10_080 },
    });
    expect(snapshot.buckets[3]?.spend).toEqual({
      used: 24.78,
      limit: 200,
      remainingPercent: 88,
      currency: "EUR",
    });
    expect(snapshot.parseWarnings).toEqual([]);
  });

  it("replaces stale Claude buckets and warnings on a complete read refresh", () => {
    const baseline = normalizeClaudeLimits(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { nimbus_quill: { utilization: 0 } },
      },
      100,
      "read",
    );
    const refresh = normalizeClaudeLimits(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 12, resets_at: null } },
      },
      200,
      "read",
    );

    const merged = mergeProviderSnapshot(baseline, refresh);

    expect(merged.buckets.map((bucket) => bucket.bucketId)).toEqual(["five_hour"]);
    expect(merged.parseWarnings).toEqual([]);
  });

  it("merges one-bucket rate_limit_event updates into an on-demand snapshot", () => {
    const baseline = normalizeClaudeLimits(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 20, resets_at: null },
          seven_day: { utilization: 50, resets_at: null },
        },
      },
      100,
      "read",
    );
    const event = normalizeClaudeLimits(
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 0.33, resetsAt: 1_786_000_000 },
      },
      200,
      "event",
    );

    const merged = mergeProviderSnapshot(baseline, event);
    expect(merged.buckets.find((bucket) => bucket.bucketId === "five_hour")?.primary).toMatchObject(
      {
        usedPercent: 33,
        resetsAt: 1_786_000_000_000,
      },
    );
    expect(
      merged.buckets.find((bucket) => bucket.bucketId === "seven_day")?.primary.usedPercent,
    ).toBe(50);
  });

  it("normalizes current Claude unifiedWindows rate-limit events", () => {
    const snapshot = normalizeClaudeLimits(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1_788_133_800,
          rateLimitType: "five_hour",
          isUsingOverage: false,
          unifiedWindows: {
            five_hour: { utilization: 0, resetsAt: 1_788_133_800 },
            seven_day: { utilization: 0.2, resetsAt: 1_788_584_400 },
          },
        },
      },
      300,
      "event",
    );

    expect(snapshot.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(snapshot.buckets[0]?.primary).toMatchObject({
      usedPercent: 0,
      resetsAt: 1_788_133_800_000,
    });
    expect(snapshot.buckets[1]?.primary).toMatchObject({
      usedPercent: 20,
      resetsAt: 1_788_584_400_000,
    });
    expect(snapshot.parseWarnings).toEqual([]);
  });

  it("ignores allowed status-only Claude rate-limit events", () => {
    const snapshot = normalizeClaudeLimits(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", isUsingOverage: false },
      },
      400,
      "event",
    );

    expect(snapshot.authState).toBe("ok");
    expect(snapshot.buckets).toEqual([]);
    expect(snapshot.parseWarnings).toEqual([]);
  });
});

describe("hybrid route audit", () => {
  it("correlates route and result records and ignores count-token probes", () => {
    const state = createHybridAuditState();
    expect(
      consumeHybridAuditRecord(state, {
        timestamp: "2026-08-29T18:00:00.000Z",
        event: "route",
        requestId: "probe",
        path: "/v1/messages/count_tokens?beta=true",
        targetProvider: "anthropic",
        targetModel: "claude-fable-5",
      }),
    ).toBeNull();
    expect(
      consumeHybridAuditRecord(state, {
        timestamp: "2026-08-29T18:00:00.100Z",
        event: "result",
        requestId: "probe",
        targetProvider: "anthropic",
        targetModel: "claude-fable-5",
        statusCode: 200,
      }),
    ).toBeNull();

    consumeHybridAuditRecord(state, {
      timestamp: "2026-08-29T18:01:00.000Z",
      event: "route",
      requestId: "chat",
      path: "/v1/messages?beta=true",
      targetProvider: "anthropic",
      targetModel: "claude-fable-5",
    });
    expect(
      consumeHybridAuditRecord(state, {
        timestamp: "2026-08-29T18:01:00.200Z",
        event: "result",
        requestId: "chat",
        targetProvider: "gpt",
        targetModel: "gpt-5.6-sol",
        statusCode: 200,
      }),
    ).toMatchObject({
      provider: "codex",
      requestedProvider: "claude",
      model: "gpt-5.6-sol",
      fallback: true,
      statusCode: 200,
    });
  });

  it("waits for the successful fallback instead of treating a transient result as served", () => {
    const state = createHybridAuditState();
    consumeHybridAuditRecord(state, {
      timestamp: "2026-08-29T18:01:00.000Z",
      event: "route",
      requestId: "chat",
      path: "/v1/messages",
      targetProvider: "anthropic",
      targetModel: "claude-fable-5",
    });
    expect(
      consumeHybridAuditRecord(state, {
        timestamp: "2026-08-29T18:01:00.100Z",
        event: "result",
        requestId: "chat",
        targetProvider: "anthropic",
        targetModel: "claude-fable-5",
        statusCode: 429,
      }),
    ).toBeNull();
    expect(
      consumeHybridAuditRecord(state, {
        timestamp: "2026-08-29T18:01:00.500Z",
        event: "result",
        requestId: "chat",
        targetProvider: "gpt",
        targetModel: "gpt-5.6-sol",
        statusCode: 200,
      })?.provider,
    ).toBe("codex");
  });

  it("drops correlations when the router records a terminal error", () => {
    const state = createHybridAuditState();
    consumeHybridAuditRecord(state, {
      event: "route",
      requestId: "failed-chat",
      path: "/v1/messages",
      targetProvider: "anthropic",
    });
    expect(state.routes.size).toBe(1);
    expect(
      consumeHybridAuditRecord(state, {
        event: "error",
        requestId: "failed-chat",
      }),
    ).toBeNull();
    expect(state.routes.size).toBe(0);
  });
});
