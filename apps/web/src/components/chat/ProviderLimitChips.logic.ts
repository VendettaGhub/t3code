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

export interface DisplayLimit extends HeadlineLimit {
  readonly code: "5" | "W" | "F";
}

export function displayLimitTone(
  usedPercent: number,
): "healthy" | "caution" | "warning" | "critical" {
  if (usedPercent >= 85) return "critical";
  if (usedPercent >= 70) return "warning";
  if (usedPercent >= 50) return "caution";
  return "healthy";
}

function displayLimitCode(
  provider: ProviderLimitsSnapshot["provider"],
  bucket: ProviderLimitBucket,
  window: ProviderLimitBucket["primary"],
): DisplayLimit["code"] | null {
  const identity = `${bucket.bucketId} ${bucket.displayName}`.toLowerCase();
  const label = window.label.trim().toLowerCase();
  const isFiveHour =
    window.windowDurationMins === 300 || label === "5h" || label.includes("5-hour");
  if (bucket.kind === "named") return null;
  if (bucket.kind === "model-weekly") {
    return provider === "claude" && identity.includes("fable") ? "F" : null;
  }
  if (isFiveHour) return "5";
  if (bucket.kind === "weekly" || label.includes("week")) return "W";
  return null;
}

export function selectDisplayLimits(
  snapshot: ProviderLimitsSnapshot,
  now = Date.now(),
): ReadonlyArray<DisplayLimit> {
  const byCode = new Map<DisplayLimit["code"], DisplayLimit>();
  for (const bucket of snapshot.buckets) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (window === undefined || (window.resetsAt !== undefined && window.resetsAt <= now)) {
        continue;
      }
      const code = displayLimitCode(snapshot.provider, bucket, window);
      if (code === null) continue;
      const candidate = { bucket, ...window, code };
      const current = byCode.get(code);
      if (current === undefined || candidate.usedPercent > current.usedPercent) {
        byCode.set(code, candidate);
      }
    }
  }
  const order: ReadonlyArray<DisplayLimit["code"]> =
    snapshot.provider === "claude" ? ["5", "W", "F"] : ["5", "W"];
  return order.flatMap((code) => {
    const limit = byCode.get(code);
    return limit ? [limit] : [];
  });
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
    if (
      `${headline.bucket.bucketId} ${headline.bucket.displayName}`.toLowerCase().includes("fable")
    ) {
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
    /^(?:anthropic\/)?gpt-5\.(?:3|6)-/.test(model) ||
    /^(?:anthropic\/)?gpt-6-astra$/.test(model)
  ) {
    return "codex";
  }
  return "claude";
}

export function resolveEmphasis(
  pickerRoute: ProviderLimitsRouteProvider,
  _lastActualRoute: ProviderLimitsActualRoute | undefined,
  _activeTurnStartedAt: number | undefined,
): "claude" | "codex" | null {
  // Audit entries are environment-wide, not correlated to a chat or turn.
  // A concurrent request must not change this composer's provider emphasis.
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
