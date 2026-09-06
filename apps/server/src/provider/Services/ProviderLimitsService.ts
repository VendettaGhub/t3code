import type {
  ProviderLimitBucket,
  ProviderLimitBucketKind,
  ProviderLimitSpend,
  ProviderLimitWindow,
  ProviderLimitsActualRoute,
  ProviderLimitsRouteProvider,
  ProviderLimitsSnapshot,
  ProviderLimitsState,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { subscribeBeforeSnapshotWithoutMutex } from "../../utils/subscribeBeforeSnapshot.ts";

import { ProviderAdapterRegistry } from "./ProviderAdapterRegistry.ts";
import { ProviderService } from "./ProviderService.ts";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function epochMs(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
}

function isoEpochMs(value: unknown, warnings: string[], bucketId: string): number | undefined {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    warnings.push(`Invalid reset timestamp for Claude bucket '${bucketId}'.`);
    return undefined;
  }
  return parsed;
}

function sparseMerge(previous: unknown, incoming: unknown): unknown {
  if (incoming === null || incoming === undefined) return previous;
  const previousRecord = record(previous);
  const incomingRecord = record(incoming);
  if (incomingRecord === undefined) return incoming;
  const merged: UnknownRecord = { ...(previousRecord ?? {}) };
  for (const [key, value] of Object.entries(incomingRecord)) {
    if (value === null || value === undefined) continue;
    merged[key] = sparseMerge(previousRecord?.[key], value);
  }
  return merged;
}

export function mergeCodexRateLimits(
  baseline: unknown,
  update: unknown,
  source: "read" | "event" = "event",
): UnknownRecord {
  if (source === "read") return record(update) ?? {};
  return (record(sparseMerge(baseline, update)) ?? {}) as UnknownRecord;
}

function windowLabel(durationMins: number | undefined, fallback: string): string {
  if (durationMins === 300) return "5h";
  if (durationMins === 10_080) return "Week";
  if (durationMins !== undefined && durationMins % 1_440 === 0) return `${durationMins / 1_440}d`;
  if (durationMins !== undefined && durationMins % 60 === 0) return `${durationMins / 60}h`;
  return fallback;
}

function codexWindow(value: unknown, fallbackLabel: string): ProviderLimitWindow | undefined {
  const input = record(value);
  const usedPercent = finiteNumber(input?.usedPercent);
  if (usedPercent === undefined) return undefined;
  const windowDurationMins = finiteNumber(input?.windowDurationMins);
  const resetsAt = epochMs(input?.resetsAt);
  return {
    usedPercent,
    label: windowLabel(windowDurationMins, fallbackLabel),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function codexSpend(value: unknown): ProviderLimitSpend | undefined {
  const input = record(value);
  const used = finiteNumber(input?.used);
  const limit = finiteNumber(input?.limit);
  const remainingPercent = finiteNumber(input?.remainingPercent);
  if (used === undefined || limit === undefined || remainingPercent === undefined) return undefined;
  const resetsAt = epochMs(input?.resetsAt);
  return { used, limit, remainingPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function normalizeCodexBucket(
  fallbackId: string,
  value: unknown,
  named: boolean,
): ProviderLimitBucket | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const bucketId = stringValue(input.limitId) ?? fallbackId;
  const displayName = stringValue(input.limitName) ?? (named ? fallbackId : "Codex");
  const primary = codexWindow(input.primary, "Primary");
  const secondary = codexWindow(input.secondary, "Secondary");
  const spend = codexSpend(input.individualLimit);
  const firstWindow = primary ?? secondary;
  if (firstWindow === undefined && spend === undefined) return undefined;
  const effectivePrimary: ProviderLimitWindow = firstWindow ?? {
    label: "Spend",
    usedPercent: Math.max(0, 100 - (spend?.remainingPercent ?? 100)),
    ...(spend?.resetsAt !== undefined ? { resetsAt: spend.resetsAt } : {}),
  };
  const kind: ProviderLimitBucketKind = named
    ? "named"
    : effectivePrimary.windowDurationMins !== undefined &&
        effectivePrimary.windowDurationMins <= 300
      ? "session"
      : effectivePrimary.windowDurationMins !== undefined &&
          effectivePrimary.windowDurationMins >= 10_000
        ? "weekly"
        : spend !== undefined
          ? "spend"
          : "unknown";
  return {
    bucketId,
    displayName,
    kind,
    primary: effectivePrimary,
    ...(primary !== undefined && secondary !== undefined ? { secondary } : {}),
    ...(spend !== undefined ? { spend } : {}),
  };
}

export function normalizeCodexLimits(
  input: unknown,
  capturedAt: number,
  source: "read" | "event",
): ProviderLimitsSnapshot {
  const root = record(input) ?? {};
  const defaultInput = record(root.rateLimits);
  const defaultBucket = normalizeCodexBucket("codex", defaultInput, false);
  const byBucketId = new Map<string, ProviderLimitBucket>();
  if (defaultBucket !== undefined) byBucketId.set(defaultBucket.bucketId, defaultBucket);
  const byId = record(root.rateLimitsByLimitId);
  for (const [limitId, value] of Object.entries(byId ?? {})) {
    const bucket = normalizeCodexBucket(limitId, value, true);
    if (bucket === undefined) continue;
    byBucketId.set(bucket.bucketId, bucket);
  }
  const buckets = Array.from(byBucketId.values());
  return {
    provider: "codex",
    buckets,
    capturedAt,
    source,
    authState: buckets.length > 0 ? "ok" : "unavailable",
    ...(stringValue(defaultInput?.planType)
      ? { planType: stringValue(defaultInput?.planType) }
      : {}),
    parseWarnings: buckets.length === 0 ? ["Codex returned no usable rate-limit buckets."] : [],
  };
}

const CLAUDE_BUCKETS: Record<
  string,
  {
    readonly displayName: string;
    readonly label: string;
    readonly kind: ProviderLimitBucketKind;
    readonly duration?: number;
  }
> = {
  five_hour: { displayName: "5-hour", label: "5h", kind: "session", duration: 300 },
  seven_day: { displayName: "Weekly", label: "Week", kind: "weekly", duration: 10_080 },
  seven_day_oauth_apps: {
    displayName: "OAuth apps weekly",
    label: "Apps",
    kind: "model-weekly",
    duration: 10_080,
  },
  seven_day_opus: {
    displayName: "Opus weekly",
    label: "Opus",
    kind: "model-weekly",
    duration: 10_080,
  },
  seven_day_sonnet: {
    displayName: "Fable weekly",
    label: "Fable",
    kind: "model-weekly",
    duration: 10_080,
  },
};

const CLAUDE_RESPONSE_METADATA = new Set([
  "limits",
  "spend",
  "member_dashboard_available",
  "nimbus_quill",
  "cinder_cove",
  "amber_ladder",
  "model_scoped",
]);

function humanizeBucketId(bucketId: string): string {
  return bucketId.replaceAll("_", " ");
}

function claudePercent(value: unknown, source: "read" | "event"): number | undefined {
  const utilization = finiteNumber(value);
  if (utilization === undefined) return undefined;
  return source === "event" && utilization >= 0 && utilization <= 1
    ? utilization * 100
    : utilization;
}

function normalizeClaudeWindowBucket(
  bucketId: string,
  value: unknown,
  source: "read" | "event",
  warnings: string[],
): ProviderLimitBucket | undefined {
  const input = record(value);
  const usedPercent = claudePercent(input?.utilization, source);
  if (usedPercent === undefined) {
    warnings.push(`Claude bucket '${bucketId}' has no numeric utilization.`);
    return undefined;
  }
  const known = CLAUDE_BUCKETS[bucketId];
  if (known === undefined) warnings.push(`Unknown Claude bucket: ${bucketId}.`);
  const resetsAt =
    source === "read" ? isoEpochMs(input?.resets_at, warnings, bucketId) : epochMs(input?.resetsAt);
  return {
    bucketId,
    displayName: known?.displayName ?? humanizeBucketId(bucketId),
    kind: known?.kind ?? "unknown",
    primary: {
      label: known?.label ?? humanizeBucketId(bucketId),
      usedPercent,
      ...(known?.duration !== undefined ? { windowDurationMins: known.duration } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
  };
}

function normalizeClaudeSpend(
  value: unknown,
  source: "read" | "event",
): ProviderLimitBucket | undefined {
  const input = record(value);
  const usedPercent = claudePercent(input?.utilization, source);
  const used = finiteNumber(input?.used_credits);
  const limit = finiteNumber(input?.monthly_limit);
  if (usedPercent === undefined && (used === undefined || limit === undefined)) return undefined;
  const effectivePercent = usedPercent ?? ((used ?? 0) / (limit ?? 1)) * 100;
  const decimalPlaces = finiteNumber(input?.decimal_places) ?? 0;
  const divisor = decimalPlaces >= 0 && decimalPlaces <= 6 ? 10 ** decimalPlaces : 1;
  const resetsAt = source === "event" ? epochMs(input?.resetsAt) : undefined;
  const spend =
    used !== undefined && limit !== undefined
      ? {
          used: used / divisor,
          limit: limit / divisor,
          remainingPercent: Math.max(0, 100 - effectivePercent),
          ...(stringValue(input?.currency) ? { currency: stringValue(input?.currency) } : {}),
        }
      : undefined;
  return {
    bucketId: "extra_usage",
    displayName: "Extra usage",
    kind: "spend",
    primary: {
      label: "Spend",
      usedPercent: effectivePercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
    ...(spend !== undefined ? { spend } : {}),
  };
}

function normalizeClaudeCurrentLimit(
  value: unknown,
  warnings: string[],
): ProviderLimitBucket | undefined {
  const input = record(value);
  const kind = stringValue(input?.kind);
  const usedPercent = finiteNumber(input?.percent);
  if (kind === undefined || usedPercent === undefined) return undefined;
  const resetsAt = isoEpochMs(input?.resets_at, warnings, kind);
  const reset = resetsAt === undefined ? {} : { resetsAt };
  if (kind === "session") {
    return {
      bucketId: "five_hour",
      displayName: "5-hour",
      kind: "session",
      primary: { label: "5h", usedPercent, windowDurationMins: 300, ...reset },
    };
  }
  if (kind === "weekly_all") {
    return {
      bucketId: "seven_day",
      displayName: "Weekly",
      kind: "weekly",
      primary: { label: "Week", usedPercent, windowDurationMins: 10_080, ...reset },
    };
  }
  if (kind !== "weekly_scoped") return undefined;
  const model = record(record(input?.scope)?.model);
  const modelId = stringValue(model?.id);
  const modelName = stringValue(model?.display_name) ?? modelId ?? "Model";
  return {
    bucketId: `seven_day_scoped:${modelId ?? modelName.toLowerCase().replaceAll(" ", "-")}`,
    displayName: `${modelName} weekly`,
    kind: "model-weekly",
    primary: { label: modelName, usedPercent, windowDurationMins: 10_080, ...reset },
  };
}

function normalizeClaudeStructuredSpend(value: unknown): ProviderLimitBucket | undefined {
  const input = record(value);
  if (input?.enabled === false) return undefined;
  const usedInput = record(input?.used);
  const limitInput = record(input?.limit);
  const usedMinor = finiteNumber(usedInput?.amount_minor);
  const limitMinor = finiteNumber(limitInput?.amount_minor);
  if (usedMinor === undefined || limitMinor === undefined) return undefined;
  const exponent = finiteNumber(usedInput?.exponent) ?? finiteNumber(limitInput?.exponent) ?? 0;
  const divisor = exponent >= 0 && exponent <= 6 ? 10 ** exponent : 1;
  const usedPercent =
    finiteNumber(input?.percent) ?? (limitMinor === 0 ? 0 : (usedMinor / limitMinor) * 100);
  const currency = stringValue(usedInput?.currency) ?? stringValue(limitInput?.currency);
  return {
    bucketId: "extra_usage",
    displayName: "Extra usage",
    kind: "spend",
    primary: { label: "Spend", usedPercent },
    spend: {
      used: usedMinor / divisor,
      limit: limitMinor / divisor,
      remainingPercent: Math.max(0, 100 - usedPercent),
      ...(currency === undefined ? {} : { currency }),
    },
  };
}

export function normalizeClaudeLimits(
  input: unknown,
  capturedAt: number,
  source: "read" | "event",
): ProviderLimitsSnapshot {
  const root = record(input) ?? {};
  const warnings: string[] = [];
  const buckets: ProviderLimitBucket[] = [];
  let planType: string | undefined;
  let authState: ProviderLimitsSnapshot["authState"] = "unavailable";

  if (source === "read") {
    planType = stringValue(root.subscription_type);
    const available = root.rate_limits_available === true;
    authState = available ? "ok" : planType === undefined ? "unauthenticated" : "unavailable";
    const limits = record(root.rate_limits);
    if (available && limits === undefined)
      warnings.push("Claude reported available rate limits without a payload.");
    const seen = new Set<string>();
    const currentLimits = Array.isArray(limits?.limits) ? limits.limits : [];
    for (const value of currentLimits) {
      const bucket = normalizeClaudeCurrentLimit(value, warnings);
      if (bucket === undefined || seen.has(bucket.bucketId)) continue;
      seen.add(bucket.bucketId);
      buckets.push(bucket);
    }
    for (const [bucketId, value] of Object.entries(limits ?? {})) {
      if (
        value === null ||
        value === undefined ||
        bucketId === "extra_usage" ||
        CLAUDE_RESPONSE_METADATA.has(bucketId)
      )
        continue;
      const bucket = normalizeClaudeWindowBucket(bucketId, value, source, warnings);
      if (bucket === undefined || seen.has(bucket.bucketId)) continue;
      seen.add(bucket.bucketId);
      buckets.push(bucket);
    }
    const spend =
      normalizeClaudeStructuredSpend(limits?.spend) ??
      normalizeClaudeSpend(limits?.extra_usage, source);
    if (spend !== undefined) buckets.push(spend);
  } else {
    const info = record(root.rate_limit_info);
    authState = info === undefined ? "unavailable" : "ok";
    const unifiedWindows = record(info?.unifiedWindows);
    if (unifiedWindows !== undefined) {
      const seen = new Set<string>();
      for (const [bucketId, value] of Object.entries(unifiedWindows)) {
        if (value === null || value === undefined || seen.has(bucketId)) continue;
        const bucket = normalizeClaudeWindowBucket(bucketId, value, source, warnings);
        if (bucket === undefined) continue;
        seen.add(bucket.bucketId);
        buckets.push(bucket);
      }
    } else {
      // Older Claude Code releases emitted one window directly on
      // rate_limit_info. Current releases can also emit status-only events;
      // absence of a bucket type is therefore valid and not a parse failure.
      const bucketId = stringValue(info?.rateLimitType);
      if (bucketId === "overage") {
        const bucket = normalizeClaudeSpend(info, source);
        if (bucket !== undefined) buckets.push(bucket);
      } else if (bucketId !== undefined) {
        const bucket = normalizeClaudeWindowBucket(bucketId, info, source, warnings);
        if (bucket !== undefined) buckets.push(bucket);
      }
    }
  }

  return {
    provider: "claude",
    buckets,
    capturedAt,
    source,
    authState,
    ...(planType !== undefined ? { planType } : {}),
    parseWarnings: warnings,
  };
}

export function mergeProviderSnapshot(
  baseline: ProviderLimitsSnapshot | undefined,
  update: ProviderLimitsSnapshot,
): ProviderLimitsSnapshot {
  if (
    baseline === undefined ||
    baseline.provider !== update.provider ||
    update.source === "read" ||
    update.authState !== "ok"
  )
    return update;
  const byId = new Map(baseline.buckets.map((bucket) => [bucket.bucketId, bucket]));
  for (const bucket of update.buckets) byId.set(bucket.bucketId, bucket);
  return {
    ...baseline,
    ...update,
    planType: update.planType ?? baseline.planType,
    buckets: Array.from(byId.values()),
    parseWarnings: Array.from(new Set([...baseline.parseWarnings, ...update.parseWarnings])),
  };
}

interface HybridAuditRoute {
  readonly requestedProvider: ProviderLimitsRouteProvider;
  readonly path: string;
}

export interface HybridAuditState {
  readonly routes: Map<string, HybridAuditRoute>;
}

export function createHybridAuditState(): HybridAuditState {
  return { routes: new Map() };
}

function auditProvider(value: unknown): ProviderLimitsRouteProvider | undefined {
  switch (value) {
    case "anthropic":
      return "claude";
    case "gpt":
      return "codex";
    case "qwen":
      return "local";
    default:
      return undefined;
  }
}

function isTransientStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

export function consumeHybridAuditRecord(
  state: HybridAuditState,
  value: unknown,
): ProviderLimitsActualRoute | null {
  const input = record(value);
  const event = stringValue(input?.event);
  const requestId = stringValue(input?.requestId);
  if (requestId === undefined) return null;
  if (event === "route") {
    const path = stringValue(input?.path) ?? "";
    const requestedProvider = auditProvider(input?.targetProvider);
    if (requestedProvider !== undefined && !path.includes("/count_tokens")) {
      state.routes.set(requestId, { requestedProvider, path });
      // Interrupted/legacy router runs may never emit a terminal record.
      if (state.routes.size > 512) {
        const oldest = state.routes.keys().next().value;
        if (oldest !== undefined) state.routes.delete(oldest);
      }
    }
    return null;
  }
  if (event === "error") {
    if (input?.willRetry !== true) state.routes.delete(requestId);
    return null;
  }
  if (event !== "result") return null;
  const route = state.routes.get(requestId);
  const provider = auditProvider(input?.targetProvider);
  const statusCode = finiteNumber(input?.statusCode);
  const model = stringValue(input?.targetModel);
  // New routers explicitly mark terminal attempts, including exhausted 429/5xx.
  // Keep legacy transient records until their following result arrives.
  if (input?.willRetry === false) state.routes.delete(requestId);
  if (
    route === undefined ||
    provider === undefined ||
    statusCode === undefined ||
    model === undefined ||
    isTransientStatus(statusCode)
  ) {
    return null;
  }
  state.routes.delete(requestId);
  const timestamp = stringValue(input?.timestamp);
  const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(at)) return null;
  return {
    provider,
    requestedProvider: route.requestedProvider,
    model,
    at,
    fallback: provider !== route.requestedProvider,
    statusCode,
  };
}

export interface ProviderLimitsServiceShape {
  readonly latest: Effect.Effect<ProviderLimitsState>;
  readonly changes: Stream.Stream<ProviderLimitsState>;
  readonly subscribe: Effect.Effect<
    {
      readonly latest: ProviderLimitsState;
      readonly changes: Stream.Stream<ProviderLimitsState>;
    },
    never,
    Scope.Scope
  >;
  readonly refresh: Effect.Effect<ProviderLimitsState>;
  readonly updateActualRoute: (route: ProviderLimitsActualRoute) => Effect.Effect<void>;
}

export class ProviderLimitsService extends Context.Reference<ProviderLimitsServiceShape>(
  "t3/provider/Services/ProviderLimitsService",
  {
    defaultValue: () => ({
      latest: Effect.succeed({}),
      changes: Stream.empty,
      subscribe: Effect.succeed({ latest: {}, changes: Stream.empty }),
      refresh: Effect.succeed({}),
      updateActualRoute: () => Effect.void,
    }),
  },
) {}

function providerKey(driver: string): "claude" | "codex" | undefined {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  return undefined;
}

export const makeProviderLimitsService = Effect.fn("makeProviderLimitsService")(function* () {
  const providers = yield* ProviderService;
  const registry = yield* ProviderAdapterRegistry;
  const stateRef = yield* Ref.make<ProviderLimitsState>({});
  const codexRawRef = yield* Ref.make<UnknownRecord | undefined>(undefined);
  const changes = yield* PubSub.sliding<ProviderLimitsState>(8);

  const publishState = Effect.fn("ProviderLimitsService.publishState")(function* (
    update: (state: ProviderLimitsState) => ProviderLimitsState,
  ) {
    const next = yield* Ref.updateAndGet(stateRef, update);
    yield* PubSub.publish(changes, next);
  });

  const applySnapshot = Effect.fn("ProviderLimitsService.applySnapshot")(function* (
    snapshot: ProviderLimitsSnapshot,
  ) {
    yield* publishState((state) => ({
      ...state,
      [snapshot.provider]: mergeProviderSnapshot(state[snapshot.provider], snapshot),
    }));
  });

  const normalizeProviderPayload = Effect.fn("ProviderLimitsService.normalizeProviderPayload")(
    function* (provider: "claude" | "codex", payload: unknown, source: "read" | "event") {
      const capturedAt = DateTime.toEpochMillis(yield* DateTime.now);
      if (provider === "codex") {
        const merged = yield* Ref.modify(codexRawRef, (previous) => {
          const next = mergeCodexRateLimits(previous, payload, source);
          return [next, next] as const;
        });
        yield* applySnapshot(normalizeCodexLimits(merged, capturedAt, source));
        return;
      }
      yield* applySnapshot(normalizeClaudeLimits(payload, capturedAt, source));
    },
  );

  const activeInstances = Effect.gen(function* () {
    const ids = yield* registry.listInstances();
    const infos = yield* Effect.forEach(ids, (id) =>
      registry.getInstanceInfo(id).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
    return infos.filter((info) => info !== undefined).filter((info) => info.enabled);
  });

  const markUnavailable = Effect.fn("ProviderLimitsService.markUnavailable")(function* (
    provider: "claude" | "codex",
    warning: string,
  ) {
    if (provider === "codex") yield* Ref.set(codexRawRef, undefined);
    const capturedAt = DateTime.toEpochMillis(yield* DateTime.now);
    yield* applySnapshot({
      provider,
      buckets: [],
      capturedAt,
      source: "read",
      authState: "unavailable",
      parseWarnings: [warning],
    });
  });
  const ambiguousWarning =
    "Multiple active instances of this provider are configured. Account-specific quota display is not supported yet; limits are hidden to avoid mixing accounts.";

  const handleRuntimeEvent = Effect.fn("ProviderLimitsService.handleRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const provider = providerKey(event.provider);
    if (provider === undefined) return;
    if (event.type !== "account.rate-limits.updated" && event.type !== "auth.status") return;
    const instances = (yield* activeInstances).filter(
      (info) => providerKey(info.driverKind) === provider,
    );
    if (instances.length > 1) {
      yield* markUnavailable(provider, ambiguousWarning);
      return;
    }
    if (
      instances.length === 0 ||
      (event.providerInstanceId !== undefined &&
        event.providerInstanceId !== instances[0]?.instanceId)
    )
      return;
    if (event.type === "account.rate-limits.updated") {
      yield* normalizeProviderPayload(provider, event.payload.rateLimits, "event");
      return;
    }
    if (event.type === "auth.status" && event.payload.error !== undefined) {
      if (provider === "codex") yield* Ref.set(codexRawRef, undefined);
      const capturedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const snapshot: ProviderLimitsSnapshot = {
        provider,
        buckets: [],
        capturedAt,
        source: "event",
        authState: "unauthenticated",
        parseWarnings: [event.payload.error],
      };
      yield* applySnapshot(snapshot);
    }
  });

  yield* Stream.runForEach(providers.streamEvents, handleRuntimeEvent).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  const refreshOnce = Effect.gen(function* () {
    const instances = yield* activeInstances;
    yield* Effect.forEach(
      ["claude", "codex"] as const,
      (provider) =>
        Effect.gen(function* () {
          const matching = instances.filter((info) => providerKey(info.driverKind) === provider);
          if (matching.length > 1) {
            yield* markUnavailable(provider, ambiguousWarning);
            return;
          }
          const instanceId = matching[0]?.instanceId;
          if (instanceId === undefined) {
            if ((yield* Ref.get(stateRef))[provider] !== undefined) {
              yield* markUnavailable(
                provider,
                "No active instance of this provider is configured.",
              );
            }
            return;
          }
          yield* Effect.gen(function* () {
            const adapter = yield* registry.getByInstance(instanceId);
            if (adapter.readProviderLimits === undefined) return;
            const sessions = yield* adapter.listSessions();
            const session = sessions.findLast((candidate) => candidate.status !== "closed");
            const payload = yield* adapter
              .readProviderLimits(session?.threadId)
              .pipe(Effect.timeout("25 seconds"));
            yield* normalizeProviderPayload(provider, payload, "read");
          }).pipe(
            Effect.catch(() =>
              markUnavailable(
                provider,
                "Could not refresh subscription limits. Check provider connectivity and authentication.",
              ),
            ),
          );
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to refresh provider subscription limits.", {
              cause,
              provider,
            }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
    return yield* Ref.get(stateRef);
  });

  const updateActualRoute = (route: ProviderLimitsActualRoute) =>
    publishState((state) => ({ ...state, lastActualRoute: route }));

  // Share an in-flight probe across clients and bound repeated process launches.
  const refreshCached = yield* Effect.cachedWithTTL(refreshOnce, "5 seconds");
  const refresh = refreshCached.pipe(Effect.andThen(Ref.get(stateRef)));

  return {
    latest: Ref.get(stateRef),
    changes: Stream.fromPubSub(changes),
    subscribe: subscribeBeforeSnapshotWithoutMutex(changes, Ref.get(stateRef)),
    refresh,
    updateActualRoute,
  } satisfies ProviderLimitsServiceShape;
});

export const ProviderLimitsServiceLive = Layer.effect(
  ProviderLimitsService,
  makeProviderLimitsService(),
);
