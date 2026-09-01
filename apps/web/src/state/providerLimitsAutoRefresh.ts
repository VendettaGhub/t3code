export const PROVIDER_LIMITS_FOCUS_STALE_MS = 60_000;
export const PROVIDER_LIMITS_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface ProviderLimitsAutoRefreshHost {
  readonly now: () => number;
  readonly isVisible: () => boolean;
  readonly setInterval: (callback: () => void, delay: number) => number;
  readonly clearInterval: (intervalId: number) => void;
  readonly addFocusListener: (listener: () => void) => () => void;
  readonly addVisibilityListener: (listener: () => void) => () => void;
}

function browserHost(): ProviderLimitsAutoRefreshHost {
  return {
    now: Date.now,
    isVisible: () => document.visibilityState === "visible",
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: (intervalId) => window.clearInterval(intervalId),
    addFocusListener: (listener) => {
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
    addVisibilityListener: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export function createProviderLimitsAutoRefresh(
  refresh: () => void,
  host: ProviderLimitsAutoRefreshHost = browserHost(),
) {
  let lastRefreshAt = host.now();
  let stopped = false;

  const refreshIfStale = (staleAfter: number) => {
    if (stopped || !host.isVisible()) return;
    const now = host.now();
    if (now - lastRefreshAt < staleAfter) return;
    lastRefreshAt = now;
    refresh();
  };

  const removeFocusListener = host.addFocusListener(() =>
    refreshIfStale(PROVIDER_LIMITS_FOCUS_STALE_MS),
  );
  const removeVisibilityListener = host.addVisibilityListener(() =>
    refreshIfStale(PROVIDER_LIMITS_FOCUS_STALE_MS),
  );
  const intervalId = host.setInterval(
    () => refreshIfStale(PROVIDER_LIMITS_REFRESH_INTERVAL_MS),
    PROVIDER_LIMITS_REFRESH_INTERVAL_MS,
  );

  return {
    refreshNow: () => {
      if (stopped) return;
      lastRefreshAt = host.now();
      refresh();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      host.clearInterval(intervalId);
      removeFocusListener();
      removeVisibilityListener();
    },
  };
}
