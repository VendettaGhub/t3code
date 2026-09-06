import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  ProviderInstanceId,
  EventId,
  ThreadId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "./ProviderAdapterRegistry.ts";
import { ProviderService } from "./ProviderService.ts";

import {
  consumeHybridAuditRecord,
  createHybridAuditState,
  mergeCodexRateLimits,
  mergeProviderSnapshot,
  normalizeClaudeLimits,
  normalizeCodexLimits,
  makeProviderLimitsService,
} from "./ProviderLimitsService.ts";

function quotaTestLayer(
  readProviderLimits: (driver: ProviderDriverKind) => Effect.Effect<unknown, ProviderAdapterError>,
  streamEvents: Stream.Stream<ProviderRuntimeEvent> = Stream.empty,
  drivers: ProviderDriverKind[] = [ProviderDriverKind.make("codex")],
  enabled: () => boolean = () => true,
) {
  const unexpected = () => Effect.die("Unexpected adapter operation in quota test");
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: ProviderDriverKind.make("codex"),
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: unexpected,
    sendTurn: unexpected,
    interruptTurn: unexpected,
    respondToRequest: unexpected,
    respondToUserInput: unexpected,
    stopSession: unexpected,
    listSessions: () => Effect.succeed([]),
    hasSession: unexpected,
    readThread: unexpected,
    rollbackThread: unexpected,
    stopAll: unexpected,
    streamEvents: Stream.empty,
    readProviderLimits: () => readProviderLimits(ProviderDriverKind.make("codex")),
  };
  const instances = drivers.map((driverKind, index) => ({
    instanceId: ProviderInstanceId.make(`${driverKind}-${index}`),
    driverKind,
    displayName: undefined,
    enabled: true,
    continuationIdentity: { driverKind, continuationKey: `test-${index}` },
  }));
  return Layer.mergeAll(
    Layer.mock(ProviderService)({ streamEvents }),
    Layer.mock(ProviderAdapterRegistry)({
      listInstances: () => Effect.succeed(instances.map((info) => info.instanceId)),
      getInstanceInfo: (id) =>
        Effect.succeed({
          ...instances.find((info) => info.instanceId === id)!,
          enabled: enabled(),
        }),
      getByInstance: (id) => {
        const provider = instances.find((info) => info.instanceId === id)!.driverKind;
        return Effect.succeed({
          ...adapter,
          provider,
          readProviderLimits: () => readProviderLimits(provider),
        });
      },
    }),
  );
}

function quotaEvent(
  payload: ProviderRuntimeEvent["payload"],
  type: "auth.status" | "account.rate-limits.updated",
): ProviderRuntimeEvent {
  return {
    eventId: EventId.make("quota-test"),
    threadId: ThreadId.make("quota-test"),
    provider: "codex",
    createdAt: "2026-09-05T00:00:00.000Z",
    type,
    payload,
  } as ProviderRuntimeEvent;
}

effectIt.effect("auth failure prevents old Codex windows from reappearing on sparse events", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(
        quotaTestLayer(
          () =>
            Effect.succeed({
              rateLimits: {
                primary: { usedPercent: 80, windowDurationMins: 300 },
                secondary: { usedPercent: 90, windowDurationMins: 10_080 },
              },
            }),
          Stream.fromQueue(events),
        ),
      ),
    );
    yield* service.refresh;
    const subscription = yield* service.subscribe;
    yield* Queue.offer(events, quotaEvent({ error: "auth failed" }, "auth.status"));
    yield* Queue.offer(
      events,
      quotaEvent(
        { rateLimits: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } } } },
        "account.rate-limits.updated",
      ),
    );
    const snapshots = yield* Stream.runCollect(subscription.changes.pipe(Stream.take(2)));
    expect(snapshots[0]?.codex?.buckets).toEqual([]);
    expect(snapshots[1]?.codex?.buckets[0]?.secondary).toBeUndefined();
    expect(snapshots[1]?.codex?.buckets[0]?.primary.usedPercent).toBe(5);
  }),
);

effectIt.effect("does not combine quotas for multiple active instances of one driver", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    let reads = 0;
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(
        quotaTestLayer(
          () => {
            reads++;
            return Effect.succeed({ rateLimits: { primary: { usedPercent: reads } } });
          },
          Stream.fromQueue(events),
          [ProviderDriverKind.make("codex"), ProviderDriverKind.make("codex")],
        ),
      ),
    );
    expect((yield* service.refresh).codex?.authState).toBe("unavailable");
    expect(reads).toBe(0);
    const subscription = yield* service.subscribe;
    yield* Queue.offer(
      events,
      quotaEvent(
        { rateLimits: { rateLimits: { primary: { usedPercent: 50 } } } },
        "account.rate-limits.updated",
      ),
    );
    const result = yield* Stream.runHead(subscription.changes);
    expect(result).toMatchObject({
      _tag: "Some",
      value: { codex: { authState: "unavailable", buckets: [] } },
    });
  }),
);

effectIt.effect(
  "clears quota after disabling its last instance without adding absent providers",
  () =>
    Effect.gen(function* () {
      let enabled = true;
      const service = yield* makeProviderLimitsService().pipe(
        Effect.provide(
          quotaTestLayer(
            () => Effect.succeed({ rateLimits: { primary: { usedPercent: 20 } } }),
            Stream.empty,
            [ProviderDriverKind.make("codex")],
            () => enabled,
          ),
        ),
      );
      expect((yield* service.refresh).codex?.authState).toBe("ok");
      enabled = false;
      yield* TestClock.adjust("5 seconds");
      const state = yield* service.refresh;
      expect(state.codex?.authState).toBe("unavailable");
      expect(state.codex?.buckets).toEqual([]);
      expect(state.claude).toBeUndefined();
    }),
);

effectIt.effect("keeps one Claude and one Codex instance available simultaneously", () =>
  Effect.gen(function* () {
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(
        quotaTestLayer(
          (driver) =>
            Effect.succeed(
              driver === "codex"
                ? { rateLimits: { primary: { usedPercent: 20 } } }
                : { rate_limits_available: true, rate_limits: { five_hour: { utilization: 30 } } },
            ),
          Stream.empty,
          [ProviderDriverKind.make("claudeAgent"), ProviderDriverKind.make("codex")],
        ),
      ),
    );
    const state = yield* service.refresh;
    expect(state.codex?.authState).toBe("ok");
    expect(state.claude?.authState).toBe("ok");
  }),
);

effectIt.effect("coalesces concurrent refreshes and enforces a short cooldown", () =>
  Effect.gen(function* () {
    let reads = 0;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(
        quotaTestLayer(() =>
          Effect.gen(function* () {
            reads += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { rateLimits: { primary: { usedPercent: 20 } } };
          }),
        ),
      ),
    );
    const pending = yield* Effect.all(
      Array.from({ length: 8 }, () => service.refresh),
      { concurrency: 8 },
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    yield* service.refresh;
    expect(reads).toBe(1);
    yield* TestClock.adjust("5 seconds");
    yield* service.refresh;
    expect(reads).toBe(2);
  }),
);

effectIt.effect("times out a wedged quota reader without leaving refresh pending", () =>
  Effect.gen(function* () {
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(quotaTestLayer(() => Effect.never)),
    );
    const pending = yield* service.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("26 seconds");
    expect((yield* Fiber.join(pending)).codex?.authState).toBe("unavailable");
  }),
);

effectIt.effect("marks failed refresh unavailable, clears stale buckets, and recovers", () =>
  Effect.gen(function* () {
    let fail = false;
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(
        quotaTestLayer(() =>
          fail
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "account/rateLimits/read",
                  detail: "private upstream failure",
                }),
              )
            : Effect.succeed({
                rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } },
              }),
        ),
      ),
    );
    expect((yield* service.refresh).codex?.authState).toBe("ok");
    fail = true;
    yield* TestClock.adjust("5 seconds");
    const failed = (yield* service.refresh).codex;
    expect(failed?.authState).toBe("unavailable");
    expect(failed?.buckets).toEqual([]);
    expect(failed?.parseWarnings.join(" ")).not.toContain("private upstream failure");
    fail = false;
    yield* TestClock.adjust("5 seconds");
    expect((yield* service.refresh).codex?.authState).toBe("ok");
  }),
);

effectIt.effect("buffers updates published after the snapshot before consumption starts", () =>
  Effect.gen(function* () {
    const service = yield* makeProviderLimitsService().pipe(
      Effect.provide(quotaTestLayer(() => Effect.succeed({}))),
    );
    const subscription = yield* service.subscribe;
    yield* service.updateActualRoute({
      provider: "codex",
      model: "test",
      at: 123,
      fallback: false,
    });
    const reader = yield* Stream.runHead(subscription.changes).pipe(
      Effect.timeoutOption("1 second"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(reader);
    expect(result).toMatchObject({
      _tag: "Some",
      value: { _tag: "Some", value: { lastActualRoute: { at: 123 } } },
    });
  }),
);

describe("Codex subscription limits", () => {
  it("replaces full reads so removed windows and previous account buckets disappear", () => {
    const baseline = {
      rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300 } },
      rateLimitsByLimitId: { oldAccount: { primary: { usedPercent: 80 } } },
    };
    const incoming = {
      rateLimits: { primary: null, secondary: { usedPercent: 20, windowDurationMins: 10_080 } },
    };
    expect(mergeCodexRateLimits(baseline, incoming, "read")).toEqual(incoming);
  });

  it("prefers named limits over the legacy bucket with the same id", () => {
    const snapshot = normalizeCodexLimits(
      {
        rateLimits: { limitId: "codex", primary: { usedPercent: 90 } },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 20, windowDurationMins: 10_080 } },
        },
      },
      123,
      "read",
    );
    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.buckets[0]?.primary.usedPercent).toBe(20);
  });

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

    expect(snapshot.buckets.map((bucket) => bucket.bucketId)).toEqual(["five_hour", "seven_day"]);
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

  it("retains retryable errors but releases exhausted fallback results", () => {
    const state = createHybridAuditState();
    consumeHybridAuditRecord(state, {
      event: "route",
      requestId: "retry",
      path: "/v1/messages",
      targetProvider: "anthropic",
    });
    consumeHybridAuditRecord(state, { event: "error", requestId: "retry", willRetry: true });
    expect(state.routes.size).toBe(1);
    expect(
      consumeHybridAuditRecord(state, {
        event: "result",
        requestId: "retry",
        targetProvider: "gpt",
        targetModel: "gpt-5.6-sol",
        timestamp: "2026-09-06T12:00:00Z",
        statusCode: 200,
        willRetry: false,
      })?.fallback,
    ).toBe(true);
    consumeHybridAuditRecord(state, {
      event: "route",
      requestId: "exhausted",
      path: "/v1/messages",
      targetProvider: "gpt",
    });
    expect(
      consumeHybridAuditRecord(state, {
        event: "result",
        requestId: "exhausted",
        targetProvider: "qwen",
        targetModel: "qwen3.8-27b",
        statusCode: 503,
        willRetry: false,
      }),
    ).toBeNull();
    expect(state.routes.size).toBe(0);
  });

  it("bounds incomplete audit correlations left by legacy or interrupted routers", () => {
    const state = createHybridAuditState();
    for (let index = 0; index < 600; index++)
      consumeHybridAuditRecord(state, {
        event: "route",
        requestId: String(index),
        path: "/v1/messages",
        targetProvider: "gpt",
      });
    expect(state.routes.size).toBe(512);
    expect(state.routes.has("599")).toBe(true);
    expect(state.routes.has("0")).toBe(false);
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
