import type { ProviderDriverKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { Maximize2Icon } from "lucide-react";
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverTrigger,
  PopoverClose,
} from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  UsageLimitsPooledRows,
  pooledAccountsSummary,
  providerColumns,
} from "../usage/UsageLimitsPooled";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export interface ComposerUsageLimitRing {
  readonly driver: ProviderDriverKind;
  readonly driverLabel: string;
  readonly id: string;
  readonly kind: LimitPoolWindow["kind"];
  readonly windowLabel: string;
  readonly shortLabel: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
}

/**
 * Keep the composer projection on the same account/window semantics as the
 * full Limits overview: all connected environments and drivers are pooled.
 */
export function collectComposerUsageLimitRings(
  presentations: Parameters<typeof collectLimitAccounts>[0],
  now: number,
): readonly ComposerUsageLimitRing[] {
  return collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) =>
    pool.windows.map((window) => ({
      driver: pool.driver,
      driverLabel: getDriverOption(pool.driver)?.label ?? String(pool.driver),
      id: window.id,
      kind: window.kind,
      windowLabel: window.label,
      shortLabel: /\bfable\b/i.test(window.label)
        ? "F"
        : window.kind === "session"
          ? "S"
          : window.kind === "weekly"
            ? "W"
            : window.label,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resets[0]?.at ?? null,
    })),
  );
}

export function hasComposerUsageLimitChrome(
  rings: readonly ComposerUsageLimitRing[],
  contextHint: ComposerBannerStackItem | null | undefined,
): boolean {
  return rings.length > 0 || (contextHint !== null && contextHint !== undefined);
}

export interface ComposerUsageLimitRingGroup {
  readonly driver: ProviderDriverKind;
  readonly driverLabel: string;
  readonly rings: readonly ComposerUsageLimitRing[];
}

/**
 * The rings as the bar draws them: one group per provider in collection order,
 * laid out over the same two columns as the details panel above (Claude left,
 * Codex right). Purely presentational; no ring is added, dropped or reordered.
 */
export function collectComposerRingColumns(
  rings: readonly ComposerUsageLimitRing[],
): readonly (readonly ComposerUsageLimitRingGroup[])[] {
  const groups: {
    driver: ProviderDriverKind;
    driverLabel: string;
    rings: ComposerUsageLimitRing[];
  }[] = [];
  for (const ring of rings) {
    const last = groups.at(-1);
    if (last && last.driver === ring.driver) last.rings.push(ring);
    else groups.push({ driver: ring.driver, driverLabel: ring.driverLabel, rings: [ring] });
  }
  return providerColumns(groups, (group) => String(group.driver));
}

export interface ComposerUsageLimitRingsProps {
  readonly now?: number;
  readonly contextHint?: ComposerBannerStackItem;
  /** Draw no pooled rings; the bar then exists only for the context hint. */
  readonly ringsHidden?: boolean;
  readonly onMaximize: () => void;
  readonly onVisibilityChange?: (visible: boolean) => void;
}

export function compactHintDescription(description: ComposerBannerStackItem["description"]) {
  return typeof description === "string"
    ? description.replace(/ tokens from earlier$/, "")
    : description;
}

export function formatRingReset(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return "?";
  const remaining = at - now;
  if (remaining <= 0) return "due";
  if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)}m`;
  if (remaining < 86_400_000) return `${Math.floor(remaining / 3_600_000)}h`;
  return `${Math.floor(remaining / 86_400_000)}d`;
}

const RING_COLOR_STOPS = [
  { at: 0, rgb: [0x22, 0xc5, 0x5e] },
  { at: 50, rgb: [0xf5, 0x9e, 0x0b] },
  { at: 100, rgb: [0xef, 0x44, 0x44] },
] as const;

/** A continuous green-to-amber-to-red ramp for the consumed quota share. */
export function usageRingColor(usedPercent: number): string {
  const used = Math.max(0, Math.min(100, usedPercent));
  const upper =
    RING_COLOR_STOPS.find((stop) => used <= stop.at) ??
    RING_COLOR_STOPS[RING_COLOR_STOPS.length - 1]!;
  let lower: (typeof RING_COLOR_STOPS)[number] = RING_COLOR_STOPS[0]!;
  for (const stop of RING_COLOR_STOPS) {
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

export function ringAriaLabel(ring: ComposerUsageLimitRing, now: number): string {
  const reset =
    ring.resetsAt === null
      ? "reset time unknown"
      : ring.resetsAt <= now
        ? "reported reset is due; awaiting refreshed limits"
        : `next reported account reset in ${formatDuration(ring.resetsAt - now)}, at ${new Date(ring.resetsAt).toISOString()}`;
  return `Pooled ${ring.driverLabel} ${ring.windowLabel}: ${ring.usedPercent}% used; ${reset}. Toggle usage limits`;
}

export function ComposerUsageLimitRingButton({
  ring,
  now,
}: {
  readonly ring: ComposerUsageLimitRing;
  readonly now: number;
}) {
  const circumference = 2 * Math.PI * 12;
  const label = ringAriaLabel(ring, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <PopoverTrigger
            render={
              <Button
                variant="ghost-muted"
                size="sm"
                aria-label={label}
                data-chat-usage-limit-ring={`${ring.driver}:${ring.kind}:${ring.id}`}
              />
            }
          >
            <svg aria-hidden="true" className="size-[30px]" viewBox="0 0 30 30">
              <circle
                cx="15"
                cy="15"
                r="12"
                fill="none"
                stroke="var(--color-usage-ring-track)"
                strokeWidth="2.5"
                opacity={0.55}
              />
              {ring.usedPercent > 0 ? (
                <circle
                  cx="15"
                  cy="15"
                  r="12"
                  fill="none"
                  stroke={usageRingColor(ring.usedPercent)}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - ring.usedPercent / 100)}
                  transform="rotate(-90 15 15)"
                />
              ) : null}
              <text
                x="15"
                y="15"
                className="fill-foreground"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="9"
                fontWeight="700"
              >
                {formatRingReset(ring.resetsAt, now)}
              </text>
            </svg>
            <span
              aria-hidden="true"
              className="whitespace-nowrap text-usage-ring leading-tight font-bold text-muted-foreground"
            >
              {ring.shortLabel}
            </span>
          </PopoverTrigger>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Compact, non-animated quota affordances for pooled provider accounts. */
export function ComposerUsageLimitRings({
  now,
  contextHint,
  ringsHidden = false,
  onMaximize,
  onVisibilityChange,
}: ComposerUsageLimitRingsProps) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const nowMinute = useNowMinute();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const effectiveNow = now ?? Date.parse(`${nowMinute}:00.000Z`);
  const rings = useMemo(
    () => (ringsHidden ? [] : collectComposerUsageLimitRings(presentations, effectiveNow)),
    [effectiveNow, presentations, ringsHidden],
  );
  const ringColumns = useMemo(() => collectComposerRingColumns(rings), [rings]);
  const summary = useMemo(
    () => pooledAccountsSummary(collectLimitAccounts(presentations)),
    [presentations],
  );
  const hasVisibleChrome = hasComposerUsageLimitChrome(rings, contextHint);

  useLayoutEffect(() => {
    onVisibilityChange?.(hasVisibleChrome);
    return () => onVisibilityChange?.(false);
  }, [hasVisibleChrome, onVisibilityChange]);

  if (!hasVisibleChrome) return null;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-chat-usage-bar="true">
        <Popover open={open} onOpenChange={setOpen}>
          <div
            ref={anchor}
            className="relative flex min-h-[38px] min-w-0 flex-nowrap items-center gap-x-1 px-1 py-1"
          >
            <div
              className={cn(
                "grid min-w-0 flex-1 items-center",
                ringColumns.length > 1 && "grid-cols-2",
                contextHint && "@max-[32rem]:pe-22",
              )}
              role="group"
              aria-label="Usage limits"
              data-chat-usage-limit-rings="true"
            >
              {ringColumns.map((column, columnIndex) => (
                <div
                  key={column[0]?.driver ?? columnIndex}
                  className={cn(
                    // Keep desktop groups centred in the full bar, independent of the hint;
                    // auto margins collapse when the group is wider than the column, so
                    // scrolling still starts at the icon.
                    "flex min-w-0 items-center overflow-x-auto py-1 [scrollbar-width:thin]",
                    columnIndex > 0 && ringColumns.length > 1 && "border-l border-border/60",
                  )}
                >
                  <div className="mx-auto flex items-center gap-1">
                    {column.map((group, groupIndex) => (
                      <Fragment key={group.driver}>
                        <span
                          role="img"
                          aria-label={group.driverLabel}
                          className={groupIndex > 0 ? "ml-1 border-l border-border pl-2" : ""}
                        >
                          <ProviderInstanceIcon
                            driverKind={group.driver}
                            displayName={group.driverLabel}
                            className="size-5"
                            iconClassName="size-4 text-foreground/80"
                          />
                        </span>
                        {group.rings.map((ring) => (
                          <ComposerUsageLimitRingButton
                            key={`${ring.driver}:${ring.kind}:${ring.id}`}
                            ring={ring}
                            now={effectiveNow}
                          />
                        ))}
                      </Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {contextHint ? (
              <div className="absolute inset-y-0 end-1 flex w-22 items-center justify-end text-xs text-muted-foreground">
                <div className="relative flex w-22 shrink-0 flex-col items-center">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="w-16 self-start truncate text-center text-2xs leading-tight" />
                      }
                    >
                      {compactHintDescription(contextHint.description) ?? contextHint.title}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {contextHint.description ?? contextHint.title}
                    </TooltipPopup>
                  </Tooltip>
                  <div className="relative flex w-full items-center justify-center pe-6 [&_button]:h-6 [&_button]:text-xs">
                    {contextHint.actions}
                    {contextHint.onDismiss ? (
                      <ComposerBanner.Dismiss
                        className="absolute end-0 size-6"
                        aria-label={contextHint.dismissLabel}
                        onClick={contextHint.onDismiss}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <PopoverPopup
            anchor={anchor}
            side="top"
            align="start"
            // The pooled view can open a reset-credit confirm from a segment.
            // That dialog is modal and this popover stays open behind it, so it
            // has to get out of the confirm's way until the confirm is gone.
            demoteUnderModal
            collisionAvoidance={{ side: "none", align: "shift" }}
            // As wide as the strip it hangs off, so rows do not wrap on a desktop composer.
            className="w-[min(var(--anchor-width,32rem),calc(100vw-1rem))]"
            padding="compact"
            viewportClassName="max-h-[min(18rem,var(--available-height))]"
          >
            <div className="mb-1.5 flex min-w-0 items-center gap-2">
              <PopoverTitle className="shrink-0">
                <span className="text-xs leading-none">Usage limits</span>
              </PopoverTitle>
              {summary ? (
                <PopoverDescription className="min-w-0">
                  <span className="truncate text-xs leading-none">
                    {summary.includes("@") ? (
                      <RedactedSensitiveText
                        key={summary}
                        value={summary}
                        ariaLabel="Toggle account label visibility"
                        revealTooltip="Click to reveal account"
                        hideTooltip="Click to hide account"
                        className="max-w-full truncate font-sans text-xs"
                      />
                    ) : (
                      summary
                    )}
                  </span>
                </PopoverDescription>
              ) : null}
              <div className="ms-auto flex shrink-0 items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    onMaximize();
                  }}
                >
                  <Maximize2Icon className="size-3" /> Maximize
                </Button>
                <PopoverClose render={<ComposerBanner.Dismiss aria-label="Close usage limits" />} />
              </div>
            </div>
            <UsageLimitsPooledRows presentations={presentations} now={effectiveNow} />
          </PopoverPopup>
        </Popover>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
