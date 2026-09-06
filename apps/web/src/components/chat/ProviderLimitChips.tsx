import type { EnvironmentId, ProviderLimitsSnapshot } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useProviderLimits } from "../../state/providerLimits";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatProviderReset,
  type ResetDisplayMode,
  useProviderResetClock,
  useProviderResetDisplayMode,
} from "../usage/providerResetDisplay";
import {
  chipState,
  type DisplayLimit,
  displayLimitTone,
  resolveEmphasis,
  routeForModel,
  selectDisplayLimits,
} from "./ProviderLimitChips.logic";

function limitName(code: DisplayLimit["code"]): string {
  if (code === "5") return "5-hour session";
  if (code === "F") return "Fable weekly";
  return "weekly";
}

function limitColor(usedPercent: number): string {
  const tone = displayLimitTone(usedPercent);
  if (tone === "critical") return "#ef4444";
  if (tone === "warning") return "#f97316";
  if (tone === "caution") return "#eab308";
  return "#22c55e";
}

function QuotaRing(props: {
  readonly provider: ProviderLimitsSnapshot["provider"];
  readonly limit: DisplayLimit;
  readonly stale: boolean;
  readonly resetDisplayMode: ResetDisplayMode;
  readonly resetNow: number;
}) {
  const normalizedPercent = Math.min(100, Math.max(0, props.limit.usedPercent));
  const roundedPercent = Math.round(normalizedPercent);
  const name = limitName(props.limit.code);
  const providerName = props.provider === "claude" ? "Claude" : "Codex";
  const color = limitColor(normalizedPercent);
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercent / 100);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "relative grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none",
              props.stale && "opacity-60",
            )}
            aria-label={`${providerName} ${name}, ${roundedPercent}% used`}
          >
            <svg
              viewBox="0 0 24 24"
              className="absolute inset-0 size-full -rotate-90 transform-gpu"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                strokeWidth="3"
              />
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <span
              className="relative font-mono text-[9px] leading-none font-bold text-foreground"
              aria-hidden="true"
            >
              {props.limit.code}
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="center"
        viewportClassName="p-0"
        className="w-56 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-xs">
              {providerName} {name}
            </span>
            <span className="text-secondary-label text-[11px] tabular-nums">
              {roundedPercent}% used
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-label={`${providerName} ${name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={roundedPercent}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${normalizedPercent}%`, backgroundColor: color }}
            />
          </div>
          <div className="text-secondary-label text-[11px]">
            {formatProviderReset(props.limit.resetsAt, props.resetDisplayMode, props.resetNow)}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ProviderRingGroup(props: {
  readonly label: "Claude" | "Codex";
  readonly snapshot: ProviderLimitsSnapshot | undefined;
  readonly emphasized: boolean;
  readonly compact: boolean;
  readonly resetDisplayMode: ResetDisplayMode;
  readonly resetNow: number;
}) {
  const state = chipState(props.snapshot);
  if (props.snapshot === undefined || (state.kind !== "ok" && state.kind !== "stale")) return null;
  const limits = selectDisplayLimits(props.snapshot);
  if (limits.length === 0) return null;
  const provider = props.snapshot.provider;
  const ProviderLogo = provider === "claude" ? ClaudeAI : OpenAI;

  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center",
        props.compact ? "gap-1.5" : "gap-2",
        props.emphasized ? "opacity-100" : "opacity-80",
      )}
      aria-label={`${props.label} subscription limits`}
      data-provider-limit-group={provider}
    >
      <ProviderLogo
        className={cn(
          "size-3.5 shrink-0",
          provider === "claude" ? "text-[#d97757]" : "text-foreground",
        )}
        data-provider-logo={provider}
        aria-hidden="true"
      />
      {limits.map((limit) => (
        <QuotaRing
          key={limit.code}
          provider={provider}
          limit={limit}
          stale={state.kind === "stale"}
          resetDisplayMode={props.resetDisplayMode}
          resetNow={props.resetNow}
        />
      ))}
    </div>
  );
}

export function ProviderLimitChips(props: {
  readonly environmentId: EnvironmentId;
  readonly selectedModel: string;
  readonly activeTurnStartedAt?: number;
  readonly compact?: boolean;
}) {
  const navigate = useNavigate();
  const limits = useProviderLimits(props.environmentId);
  const [resetDisplayMode] = useProviderResetDisplayMode();
  const resetNow = useProviderResetClock();
  const effectiveProvider = resolveEmphasis(
    routeForModel(props.selectedModel),
    limits.data?.lastActualRoute,
    props.activeTurnStartedAt,
  );

  return (
    <div
      className="ml-1 hidden h-7 shrink-0 items-center gap-3 sm:flex"
      data-effective-quota-provider={effectiveProvider ?? "local"}
    >
      <ProviderRingGroup
        label="Claude"
        snapshot={limits.data?.claude}
        emphasized={effectiveProvider === "claude"}
        compact={props.compact === true}
        resetDisplayMode={resetDisplayMode}
        resetNow={resetNow}
      />
      <ProviderRingGroup
        label="Codex"
        snapshot={limits.data?.codex}
        emphasized={effectiveProvider === "codex"}
        compact={props.compact === true}
        resetDisplayMode={resetDisplayMode}
        resetNow={resetNow}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="-ml-1.5"
        aria-label="Open detailed usage"
        onClick={() => void navigate({ to: "/usage" })}
      >
        <ActivityIcon className="size-3.5" />
      </Button>
    </div>
  );
}
