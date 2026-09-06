import type {
  EnvironmentId,
  ProviderLimitsActualRoute,
  ProviderLimitsSnapshot,
  ProviderLimitsState,
} from "@t3tools/contracts";

export type QuotaProvider = "claude" | "codex";

export interface ProviderLimitsEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly data: ProviderLimitsState | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly accountIds: Readonly<Partial<Record<QuotaProvider, string>>>;
}

export interface ProviderLimitsAccountGroup {
  readonly key: string;
  readonly provider: QuotaProvider;
  readonly accountId: string | null;
  readonly snapshot: ProviderLimitsSnapshot;
  readonly environmentIds: readonly EnvironmentId[];
}

export interface GroupedProviderLimits {
  readonly accounts: readonly ProviderLimitsAccountGroup[];
  readonly lastActualRoute: ProviderLimitsActualRoute | null;
  readonly errors: readonly string[];
  readonly isPending: boolean;
}

const PROVIDER_ORDER: Readonly<Record<QuotaProvider, number>> = { claude: 0, codex: 1 };

export function groupProviderLimits(
  environments: readonly ProviderLimitsEnvironmentState[],
): GroupedProviderLimits {
  const groups = new Map<string, ProviderLimitsAccountGroup>();
  const unavailableAccountAt = new Map<string, number>();
  const errors = new Set(environments.flatMap((environment) => environment.error ?? []));
  let lastActualRoute: ProviderLimitsActualRoute | null = null;

  for (const environment of environments) {
    const route = environment.data?.lastActualRoute;
    if (route && (lastActualRoute === null || route.at > lastActualRoute.at)) {
      lastActualRoute = route;
    }

    for (const provider of ["claude", "codex"] as const) {
      const snapshot = environment.data?.[provider];
      if (snapshot && snapshot.authState !== "ok") {
        const providerName = provider === "claude" ? "Claude" : "Codex";
        const warnings = snapshot.parseWarnings.length
          ? snapshot.parseWarnings
          : [
              snapshot.authState === "unauthenticated"
                ? "Sign in to view usage."
                : "Usage is unavailable.",
            ];
        for (const warning of warnings)
          errors.add(`${environment.label} · ${providerName}: ${warning}`);
      }
      const accountId = environment.accountIds[provider]?.trim().toLowerCase() || null;
      const key = accountId
        ? `${provider}:account:${accountId}`
        : `${provider}:environment:${environment.environmentId}`;

      if (!snapshot?.buckets.length) {
        if (snapshot && accountId && snapshot.authState !== "ok") {
          const previousUnavailableAt = unavailableAccountAt.get(key);
          if (previousUnavailableAt === undefined || snapshot.capturedAt > previousUnavailableAt) {
            unavailableAccountAt.set(key, snapshot.capturedAt);
            const previous = groups.get(key);
            if (previous && previous.snapshot.capturedAt <= snapshot.capturedAt) {
              groups.delete(key);
            }
          }
        }
        continue;
      }

      const unavailableAt = unavailableAccountAt.get(key);
      if (unavailableAt !== undefined && unavailableAt >= snapshot.capturedAt) continue;

      const previous = groups.get(key);
      if (previous === undefined) {
        groups.set(key, {
          key,
          provider,
          accountId,
          snapshot,
          environmentIds: [environment.environmentId],
        });
      } else {
        groups.set(key, {
          ...previous,
          snapshot:
            snapshot.capturedAt > previous.snapshot.capturedAt ? snapshot : previous.snapshot,
          environmentIds: [...previous.environmentIds, environment.environmentId],
        });
      }
    }
  }

  return {
    accounts: [...groups.values()].sort(
      (left, right) =>
        PROVIDER_ORDER[left.provider] - PROVIDER_ORDER[right.provider] ||
        left.key.localeCompare(right.key),
    ),
    lastActualRoute,
    errors: [...errors],
    isPending:
      environments.length > 0 && environments.every((environment) => environment.isPending),
  };
}
