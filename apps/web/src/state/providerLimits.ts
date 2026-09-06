import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderLimitsState, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import type {
  ProviderLimitsEnvironmentState,
  QuotaProvider,
} from "../components/usage/ProviderLimitsPanel.logic";
import { environmentPresentations } from "./presentation";
import { createProviderLimitsAutoRefresh } from "./providerLimitsAutoRefresh";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

function useProviderLimitsRefresh(refresh: () => void) {
  const refreshRef = useRef(refresh);
  const controllerRef = useRef<ReturnType<typeof createProviderLimitsAutoRefresh> | null>(null);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const controller = createProviderLimitsAutoRefresh(() => refreshRef.current());
    controllerRef.current = controller;
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, []);

  return useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null) {
      refreshRef.current();
      return;
    }
    controller.refreshNow();
  }, []);
}

function accountIdForProvider(
  provider: QuotaProvider,
  config: ServerConfig | null,
): string | undefined {
  const driver = provider === "claude" ? "claudeAgent" : "codex";
  const accountIds = new Set(
    (config?.providers ?? [])
      .filter(
        (candidate) =>
          candidate.driver === driver &&
          candidate.auth.status === "authenticated" &&
          candidate.auth.email !== undefined,
      )
      .map((candidate) => candidate.auth.email?.trim().toLowerCase())
      .filter((email): email is string => Boolean(email)),
  );
  // A provider-level quota cannot be assigned safely if one environment exposes
  // multiple accounts for the same driver. In that case keep the environment
  // separate instead of guessing.
  return accountIds.size === 1 ? accountIds.values().next().value : undefined;
}

const allProviderLimitsAtom = Atom.make((get): readonly ProviderLimitsEnvironmentState[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const environments: ProviderLimitsEnvironmentState[] = [];

  for (const [environmentId, presentation] of presentations) {
    const target = { environmentId, input: {} };
    const live = get(serverEnvironment.providerLimits(target));
    const initial = get(serverEnvironment.providerLimitsRefresh(target));
    const data =
      Option.getOrNull(AsyncResult.value(live)) ?? Option.getOrNull(AsyncResult.value(initial));
    const config = get(serverEnvironment.configValueAtom(environmentId));
    const claudeAccountId = accountIdForProvider("claude", config);
    const codexAccountId = accountIdForProvider("codex", config);

    environments.push({
      environmentId,
      label: presentation.entry.target.label,
      data,
      error:
        live._tag === "Failure" || initial._tag === "Failure"
          ? `${presentation.entry.target.label} could not report live subscription quota.`
          : null,
      isPending: data === null && (live.waiting || initial.waiting),
      accountIds: {
        ...(claudeAccountId !== undefined ? { claude: claudeAccountId } : {}),
        ...(codexAccountId !== undefined ? { codex: codexAccountId } : {}),
      },
    });
  }
  return environments;
}).pipe(Atom.withLabel("web-provider-limits:all-environments"));

export function useProviderLimits(environmentId: EnvironmentId | null) {
  const target = environmentId === null ? null : { environmentId, input: {} };
  const live = useEnvironmentQuery(
    target === null ? null : serverEnvironment.providerLimits(target),
  );
  const initial = useEnvironmentQuery(
    target === null ? null : serverEnvironment.providerLimitsRefresh(target),
  );
  const data: ProviderLimitsState | null = live.data ?? initial.data;
  const refresh = useProviderLimitsRefresh(initial.refresh);
  return {
    data,
    error: live.error ?? initial.error,
    isPending: data === null && (live.isPending || initial.isPending),
    refresh,
  };
}

export function useAllProviderLimits() {
  const environments = useAtomValue(allProviderLimitsAtom);
  const refreshAll = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.providerLimitsRefresh({
          environmentId: environment.environmentId,
          input: {},
        }),
      );
    }
  }, [environments]);
  const refresh = useProviderLimitsRefresh(refreshAll);
  return { environments, refresh };
}
