import * as Schema from "effect/Schema";

export const ProviderLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.Number),
  windowDurationMins: Schema.optional(Schema.Number),
  label: Schema.String,
});
export type ProviderLimitWindow = typeof ProviderLimitWindow.Type;

export const ProviderLimitBucketKind = Schema.Literals([
  "session",
  "weekly",
  "model-weekly",
  "spend",
  "credits",
  "named",
  "unknown",
]);
export type ProviderLimitBucketKind = typeof ProviderLimitBucketKind.Type;

export const ProviderLimitSpend = Schema.Struct({
  used: Schema.Number,
  limit: Schema.Number,
  remainingPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.Number),
  currency: Schema.optional(Schema.String),
});
export type ProviderLimitSpend = typeof ProviderLimitSpend.Type;

export const ProviderLimitBucket = Schema.Struct({
  bucketId: Schema.String,
  displayName: Schema.String,
  kind: ProviderLimitBucketKind,
  primary: ProviderLimitWindow,
  secondary: Schema.optional(ProviderLimitWindow),
  spend: Schema.optional(ProviderLimitSpend),
});
export type ProviderLimitBucket = typeof ProviderLimitBucket.Type;

export const ProviderLimitsAuthState = Schema.Literals(["ok", "unauthenticated", "unavailable"]);
export type ProviderLimitsAuthState = typeof ProviderLimitsAuthState.Type;

export const ProviderLimitsProvider = Schema.Literals(["claude", "codex"]);
export type ProviderLimitsProvider = typeof ProviderLimitsProvider.Type;

export const ProviderLimitsSnapshot = Schema.Struct({
  provider: ProviderLimitsProvider,
  buckets: Schema.Array(ProviderLimitBucket),
  capturedAt: Schema.Number,
  source: Schema.Literals(["read", "event"]),
  authState: ProviderLimitsAuthState,
  planType: Schema.optional(Schema.String),
  parseWarnings: Schema.Array(Schema.String),
});
export type ProviderLimitsSnapshot = typeof ProviderLimitsSnapshot.Type;

export const ProviderLimitsRouteProvider = Schema.Literals(["claude", "codex", "local"]);
export type ProviderLimitsRouteProvider = typeof ProviderLimitsRouteProvider.Type;

export const ProviderLimitsActualRoute = Schema.Struct({
  provider: ProviderLimitsRouteProvider,
  requestedProvider: Schema.optional(ProviderLimitsRouteProvider),
  model: Schema.String,
  at: Schema.Number,
  fallback: Schema.Boolean,
  statusCode: Schema.optional(Schema.Number),
});
export type ProviderLimitsActualRoute = typeof ProviderLimitsActualRoute.Type;

export const ProviderLimitsState = Schema.Struct({
  claude: Schema.optional(ProviderLimitsSnapshot),
  codex: Schema.optional(ProviderLimitsSnapshot),
  lastActualRoute: Schema.optional(ProviderLimitsActualRoute),
});
export type ProviderLimitsState = typeof ProviderLimitsState.Type;
