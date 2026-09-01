import type {
  EnvironmentId,
  ProviderLimitBucket,
  ProviderLimitsSnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon, RefreshCwIcon } from "lucide-react";

import { useProviderLimits } from "../../state/providerLimits";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ClaudeAI, OpenAI } from "../Icons";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  chipState,
  headlineCode,
  resolveEmphasis,
  routeForModel,
} from "./ProviderLimitChips.logic";

function formatReset(timestamp: number | undefined): string {
  if (timestamp === undefined) return "Reset unknown";
  return `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(timestamp)}`;
}

function formatSpend(bucket: ProviderLimitBucket): string | null {
  if (bucket.spend === undefined) return null;
  const { used, limit, currency } = bucket.spend;
  const formatter = new Intl.NumberFormat(undefined, {
    ...(currency ? { style: "currency" as const, currency } : {}),
    maximumFractionDigits: 2,
  });
  return `${formatter.format(used)} / ${formatter.format(limit)}`;
}

function BucketDetail({ bucket }: { readonly bucket: ProviderLimitBucket }) {
  const windows = [bucket.primary, bucket.secondary].filter(
    (window): window is ProviderLimitBucket["primary"] => window !== undefined,
  );
  const spend = formatSpend(bucket);
  return (
    <div className="space-y-1.5">
      <div className="truncate text-xs font-medium text-foreground">{bucket.displayName}</div>
      {windows.map((window, index) => (
        <div key={`${window.label}-${index}`} className="space-y-1 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {window.label} · {formatReset(window.resetsAt)}
            </span>
            <span className="shrink-0 font-medium tabular-nums">
              {Math.round(window.usedPercent)}% used
            </span>
          </div>
          <div
            className="h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`${bucket.displayName} ${window.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(window.usedPercent)}
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
            />
          </div>
        </div>
      ))}
      {spend ? <div className="text-xs text-muted-foreground">Spend {spend}</div> : null}
    </div>
  );
}

function ProviderChip(props: {
  readonly label: "Claude" | "Codex";
  readonly snapshot: ProviderLimitsSnapshot | undefined;
  readonly refresh: () => void;
  readonly emphasized: boolean;
  readonly compact: boolean;
}) {
  const state = chipState(props.snapshot);
  const provider = props.snapshot?.provider ?? (props.label === "Claude" ? "claude" : "codex");
  const ProviderLogo = provider === "claude" ? ClaudeAI : OpenAI;
  const suffix =
    state.headline === null
      ? "—"
      : `${headlineCode(provider, state.headline)} ${Math.round(state.headline.usedPercent)}%`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={cn(
              "h-7 shrink-0 gap-1 px-2 text-xs tabular-nums",
              props.emphasized && "bg-accent text-accent-foreground ring-1 ring-border/70",
            )}
            aria-label={`${props.label} subscription limits`}
          />
        }
      >
        <ProviderLogo
          className="size-3.5 shrink-0"
          data-provider-logo={provider}
          aria-hidden="true"
        />
        <span className={state.kind === "ok" ? "text-foreground" : "text-muted-foreground"}>
          {suffix}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{props.label} live quota</div>
            <div className="text-xs text-muted-foreground">
              {state.kind === "ok" ? "Current" : state.kind}
            </div>
          </div>
          <Button type="button" size="icon-sm" variant="ghost" onClick={props.refresh}>
            <RefreshCwIcon className="size-3.5" />
            <span className="sr-only">Refresh {props.label} limits</span>
          </Button>
        </div>
        {props.snapshot?.buckets.length ? (
          <div className="space-y-3">
            {props.snapshot.buckets.map((bucket) => (
              <BucketDetail key={bucket.bucketId} bucket={bucket} />
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No subscription quota reported.</div>
        )}
        {props.snapshot?.parseWarnings.map((warning) => (
          <div key={warning} className="mt-2 text-xs text-destructive">
            {warning}
          </div>
        ))}
      </PopoverPopup>
    </Popover>
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
  const effectiveProvider = resolveEmphasis(
    routeForModel(props.selectedModel),
    limits.data?.lastActualRoute,
    props.activeTurnStartedAt,
  );
  return (
    <div
      className="hidden shrink-0 items-center gap-0.5 sm:flex"
      data-effective-quota-provider={effectiveProvider ?? "local"}
    >
      <ProviderChip
        label="Claude"
        snapshot={limits.data?.claude}
        refresh={limits.refresh}
        emphasized={effectiveProvider === "claude"}
        compact={props.compact === true}
      />
      <ProviderChip
        label="Codex"
        snapshot={limits.data?.codex}
        refresh={limits.refresh}
        emphasized={effectiveProvider === "codex"}
        compact={props.compact === true}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Open detailed usage"
        onClick={() => void navigate({ to: "/usage" })}
      >
        <ActivityIcon className="size-3.5" />
      </Button>
    </div>
  );
}
