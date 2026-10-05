import type { UsageLimitsReport } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";

const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
};

export type ComposerLimitPresentations = Parameters<typeof collectLimitAccounts>[0];

export interface ComposerUsageRing {
  readonly driver: string;
  readonly driverLabel: string;
  readonly id: string;
  readonly kind: LimitPoolWindow["kind"];
  readonly windowLabel: string;
  readonly shortLabel: string;
  /** The amount consumed, not the amount remaining. */
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

const RING_STOPS = [
  { at: 0, rgb: [0x22, 0xc5, 0x5e] },
  { at: 50, rgb: [0xf5, 0x9e, 0x0b] },
  { at: 100, rgb: [0xef, 0x44, 0x44] },
] as const;

/**
 * The arc colour for a consumed share: green while the window is untouched,
 * amber through the middle, red once it is spent. A continuous ramp rather
 * than three buckets, so the ring reads as filling up rather than jumping.
 */
export function usageRingColor(usedPercent: number): string {
  const used = Math.max(0, Math.min(100, usedPercent));
  const upper = RING_STOPS.find((stop) => used <= stop.at) ?? RING_STOPS[RING_STOPS.length - 1]!;
  let lower: (typeof RING_STOPS)[number] = RING_STOPS[0]!;
  for (const stop of RING_STOPS) {
    if (stop.at > used) break;
    lower = stop;
  }
  const span = upper.at - lower.at;
  const share = span === 0 ? 0 : (used - lower.at) / span;
  const channel = (index: number) =>
    Math.round(lower.rgb[index]! + (upper.rgb[index]! - lower.rgb[index]!) * share)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * The reset as one glanceable token that fits inside the ring: `4d`, `2h`,
 * `35m`, or `now`. Null when the window reports no reset at all.
 */
export function formatResetCountdown(resetsAt: string | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const remaining = at - now;
  if (remaining <= 0) return "now";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.max(1, minutes)}m`;
}

export interface ComposerUsageGroup {
  readonly driver: string;
  readonly driverLabel: string;
  readonly rings: readonly ComposerUsageRing[];
}

const DRIVER_COLUMN_ORDER: Partial<Record<string, number>> = { claudeAgent: 0, codex: 1 };

/** Claude reads first, then Codex; anything else keeps its pooled order after them. */
export function composerDriverRank(driver: string): number {
  return DRIVER_COLUMN_ORDER[driver] ?? Object.keys(DRIVER_COLUMN_ORDER).length;
}

export function groupComposerUsageRings(
  rings: readonly ComposerUsageRing[],
): readonly ComposerUsageGroup[] {
  const groups: Array<{ driver: string; driverLabel: string; rings: ComposerUsageRing[] }> = [];
  for (const ring of rings) {
    const group = groups.find((candidate) => candidate.driver === ring.driver);
    if (group) group.rings.push(ring);
    else groups.push({ driver: ring.driver, driverLabel: ring.driverLabel, rings: [ring] });
  }
  return groups
    .map((group, index) => ({ group, index }))
    .sort(
      (left, right) =>
        composerDriverRank(left.group.driver) - composerDriverRank(right.group.driver) ||
        left.index - right.index,
    )
    .map(({ group }) => group);
}

function shortWindowLabel(window: LimitPoolWindow["members"][number]["window"]): string {
  if (/\bfable\b/i.test(window.label)) return "F";
  if (window.kind === "session") return "S";
  if (window.kind === "weekly") return "W";
  if (window.kind === "monthly") return "M";
  return window.label.trim().slice(0, 1).toUpperCase() || "?";
}

/** Same all-environment account/window pooling as Usage → Limits. */
export function collectComposerUsageRings(
  presentations: ComposerLimitPresentations,
  now: number,
): readonly ComposerUsageRing[] {
  return collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) =>
    pool.windows.map((window) => ({
      driver: pool.driver,
      driverLabel: DRIVER_LABEL[pool.driver] ?? String(pool.driver),
      id: window.id,
      kind: window.kind,
      windowLabel: window.label,
      shortLabel: shortWindowLabel(window.members[0]!.window),
      usedPercent: window.usedPercent,
      ...(window.resets[0] ? { resetsAt: new Date(window.resets[0].at).toISOString() } : {}),
    })),
  );
}

/** Build the same combined detail report used by the composer panel. */
export function collectComposerUsageLimits(
  presentations: ComposerLimitPresentations,
  now: number,
): UsageLimitsReport | null {
  const accounts = collectLimitAccounts(presentations);
  const notices = collectLimitNotices(presentations);
  if (accounts.length === 0 && notices.length === 0) return null;
  return {
    createdAt: new Date(now).toISOString(),
    // The panel re-reads the pooled presentation below; this report only
    // carries the opening timestamp and any source/provider notices.
    accounts: [],
    notices: [...notices],
  };
}
