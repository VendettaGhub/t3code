import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export type ResetDisplayMode = "countdown" | "date";

const RESET_DISPLAY_MODE_KEY = "t3code:usage-reset-display-mode";
const ResetDisplayModeSchema = Schema.Literals(["countdown", "date"]);

export function useProviderResetDisplayMode() {
  return useLocalStorage<ResetDisplayMode, ResetDisplayMode>(
    RESET_DISPLAY_MODE_KEY,
    "countdown",
    ResetDisplayModeSchema,
  );
}

export function useProviderResetClock(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

export function formatProviderReset(
  timestamp: number | undefined,
  mode: ResetDisplayMode,
  now = Date.now(),
): string {
  if (timestamp === undefined) return "Reset unknown";
  if (mode === "date") {
    return `Resets ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(timestamp)}`;
  }

  const remainingMs = timestamp - now;
  if (remainingMs <= 0) return "Reset due";

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `Resets in ${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `Resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `Resets in ${minutes}m`;
}
