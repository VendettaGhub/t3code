import { useCallback } from "react";

import { ensureClientSettingsHydrated, updateClientSettingsDurably } from "../hooks/useSettings";

/**
 * Marks first-run onboarding finished (or skipped) so FirstRunGate never
 * routes to the welcome wizard again. The gate itself lives in
 * `components/onboarding/FirstRunGate.tsx`.
 */
export function useCompleteOnboarding(): () => Promise<void> {
  return useCallback(async () => {
    await ensureClientSettingsHydrated();
    await updateClientSettingsDurably({ onboardingCompletedAt: new Date().toISOString() });
  }, []);
}
