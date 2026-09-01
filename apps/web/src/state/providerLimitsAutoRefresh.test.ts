import { describe, expect, it, vi } from "vite-plus/test";

import {
  createProviderLimitsAutoRefresh,
  PROVIDER_LIMITS_FOCUS_STALE_MS,
  PROVIDER_LIMITS_REFRESH_INTERVAL_MS,
  type ProviderLimitsAutoRefreshHost,
} from "./providerLimitsAutoRefresh";

function makeHost() {
  let now = 0;
  let visible = true;
  let interval: (() => void) | undefined;
  const focusListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const clearInterval = vi.fn();

  const host: ProviderLimitsAutoRefreshHost = {
    now: () => now,
    isVisible: () => visible,
    setInterval: (callback, delay) => {
      expect(delay).toBe(PROVIDER_LIMITS_REFRESH_INTERVAL_MS);
      interval = callback;
      return 1;
    },
    clearInterval,
    addFocusListener: (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    addVisibilityListener: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  };

  return {
    host,
    setNow: (value: number) => {
      now = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    fireInterval: () => interval?.(),
    fireFocus: () => focusListeners.forEach((listener) => listener()),
    fireVisibility: () => visibilityListeners.forEach((listener) => listener()),
    listenerCounts: () => ({ focus: focusListeners.size, visibility: visibilityListeners.size }),
    clearInterval,
  };
}

describe("provider limits auto refresh", () => {
  it("refreshes every five minutes while visible", () => {
    const fixture = makeHost();
    const refresh = vi.fn();
    createProviderLimitsAutoRefresh(refresh, fixture.host);

    fixture.setNow(PROVIDER_LIMITS_REFRESH_INTERVAL_MS);
    fixture.fireInterval();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not poll while hidden and refreshes when returning stale", () => {
    const fixture = makeHost();
    const refresh = vi.fn();
    createProviderLimitsAutoRefresh(refresh, fixture.host);

    fixture.setVisible(false);
    fixture.setNow(PROVIDER_LIMITS_REFRESH_INTERVAL_MS);
    fixture.fireInterval();
    expect(refresh).not.toHaveBeenCalled();

    fixture.setVisible(true);
    fixture.fireVisibility();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("requires sixty seconds of staleness and deduplicates focus with visibility", () => {
    const fixture = makeHost();
    const refresh = vi.fn();
    createProviderLimitsAutoRefresh(refresh, fixture.host);

    fixture.setNow(PROVIDER_LIMITS_FOCUS_STALE_MS - 1);
    fixture.fireFocus();
    expect(refresh).not.toHaveBeenCalled();

    fixture.setNow(PROVIDER_LIMITS_FOCUS_STALE_MS);
    fixture.fireFocus();
    fixture.fireVisibility();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("counts a manual refresh when throttling the next focus refresh", () => {
    const fixture = makeHost();
    const refresh = vi.fn();
    const controller = createProviderLimitsAutoRefresh(refresh, fixture.host);

    fixture.setNow(50_000);
    controller.refreshNow();
    fixture.setNow(50_000 + PROVIDER_LIMITS_FOCUS_STALE_MS - 1);
    fixture.fireFocus();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("removes listeners and the interval when stopped", () => {
    const fixture = makeHost();
    const controller = createProviderLimitsAutoRefresh(vi.fn(), fixture.host);
    expect(fixture.listenerCounts()).toEqual({ focus: 1, visibility: 1 });

    controller.stop();

    expect(fixture.listenerCounts()).toEqual({ focus: 0, visibility: 0 });
    expect(fixture.clearInterval).toHaveBeenCalledWith(1);
  });
});
