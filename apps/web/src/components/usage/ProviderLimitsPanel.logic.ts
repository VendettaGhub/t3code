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
  let lastActualRoute: ProviderLimitsActualRoute | null = null;

  for (const environment of environments) {
    const route = environment.data?.lastActualRoute;
    if (route && (lastActualRoute === null || route.at > lastActualRoute.at)) {
      lastActualRoute = route;
    }

    for (const provider of ["claude", "codex"] as const) {
      const snapshot = environment.data?.[provider];
      if (!snapshot?.buckets.length) continue;

      const accountId = environment.accountIds[provider]?.trim().toLocaleLowerCase() || null;
      const key = accountId
        ? `${provider}:account:${accountId}`
        : `${provider}:environment:${environment.environmentId}`;
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
          snapshot: snapshot.capturedAt > previous.snapshot.capturedAt ? snapshot : previous.snapshot,
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
    errors: [...new Set(environments.flatMap((environment) => environment.error ?? []))],
    isPending: environments.length > 0 && environments.every((environment) => environment.isPending),
  };
}
