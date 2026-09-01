import type {
  ProviderLimitBucket,
  ProviderLimitsActualRoute,
  ProviderLimitsRouteProvider,
  ProviderLimitsSnapshot,
} from "@t3tools/contracts";

export interface HeadlineLimit {
  readonly bucket: ProviderLimitBucket;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: number | undefined;
  readonly windowDurationMins?: number | undefined;
}

export function selectHeadlineBucket(
  snapshot: ProviderLimitsSnapshot,
  now = Date.now(),
): HeadlineLimit | null {
  const candidates = snapshot.buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].flatMap((window) =>
      window === undefined || (window.resetsAt !== undefined && window.resetsAt <= now)
        ? []
        : [{ bucket, ...window }],
    ),
  );
  const allowedKinds =
    snapshot.provider === "claude"
      ? new Set(["session", "weekly", "model-weekly"])
      : new Set(["session", "weekly"]);
  const preferred = candidates.filter((candidate) => allowedKinds.has(candidate.bucket.kind));
  return preferred.reduce<HeadlineLimit | null>(
    (best, candidate) =>
      best === null || candidate.usedPercent > best.usedPercent ? candidate : best,
    null,
  );
}

export function headlineCode(
  provider: ProviderLimitsSnapshot["provider"],
  headline: HeadlineLimit,
): string {
  if (headline.windowDurationMins === 300 || headline.label.toLowerCase() === "5h") return "5h";
  if (provider === "codex") return "W";
  if (headline.bucket.kind === "model-weekly") {
    if (`${headline.bucket.bucketId} ${headline.bucket.displayName}`.toLowerCase().includes("fable")) {
      return "F";
    }
    return headline.bucket.displayName.trim().charAt(0).toUpperCase() || "M";
  }
  return "A";
}

function stripRoutingCarriers(modelId: string): string {
  let model = modelId.trim();
  let previous = "";
  while (model !== previous) {
    previous = model;
    model = model
      .replace(/\[fast=true\]$/i, "")
      .replace(/\[effort=(?:low|medium|high|xhigh|max)\]$/i, "")
      .replace(/\[1m\]$/i, "");
  }
  return model;
}

export function routeForModel(modelId: string): ProviderLimitsRouteProvider {
  const model = stripRoutingCarriers(modelId).toLowerCase();
  if (model === "qwen3.8-27b" || model.startsWith("qwen")) return "local";
  if (
    model === "claude-sonnet-5" ||
    model === "claude-haiku-4-5" ||
    /^(?:anthropic\/)?gpt-5\.(?:3|6)-/.test(model)
  ) {
    return "codex";
  }
  return "claude";
}

export function resolveEmphasis(
  pickerRoute: ProviderLimitsRouteProvider,
  lastActualRoute: ProviderLimitsActualRoute | undefined,
  activeTurnStartedAt: number | undefined,
): "claude" | "codex" | null {
  if (
    activeTurnStartedAt !== undefined &&
    lastActualRoute !== undefined &&
    lastActualRoute.at >= activeTurnStartedAt
  ) {
    return lastActualRoute.provider === "local" ? null : lastActualRoute.provider;
  }
  return pickerRoute === "local" ? null : pickerRoute;
}

export type ProviderLimitChipState =
  | { readonly kind: "ok" | "stale"; readonly headline: HeadlineLimit | null }
  | { readonly kind: "unauthenticated" | "unavailable"; readonly headline: null };

export function chipState(
  snapshot: ProviderLimitsSnapshot | undefined,
  now = Date.now(),
  staleAfterMs = 10 * 60_000,
): ProviderLimitChipState {
  if (snapshot === undefined || snapshot.authState === "unavailable") {
    return { kind: "unavailable", headline: null };
  }
  if (snapshot.authState === "unauthenticated") {
    return { kind: "unauthenticated", headline: null };
  }
  return {
    kind: now - snapshot.capturedAt > staleAfterMs ? "stale" : "ok",
    headline: selectHeadlineBucket(snapshot, now),
  };
}
