import type { ProviderLimitBucket, ProviderLimitsActualRoute, ProviderLimitsSnapshot } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { useAllProviderLimits } from "../../state/providerLimits";
import { Button } from "../ui/button";
import { groupProviderLimits, type ProviderLimitsAccountGroup } from "./ProviderLimitsPanel.logic";

function maskAccountId(accountId: string): string {
  const at = accountId.indexOf("@");
  if (at <= 1) return accountId;
  return `${accountId[0]}***${accountId.slice(at)}`;
}

function formatReset(timestamp: number | undefined): string {
  if (timestamp === undefined) return "Reset unknown";
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(timestamp)}`;
}

function formatSpend(bucket: ProviderLimitBucket): string | null {
  if (bucket.spend === undefined) return null;
  const formatter = new Intl.NumberFormat(undefined, {
    ...(bucket.spend.currency
      ? { style: "currency" as const, currency: bucket.spend.currency }
      : {}),
    maximumFractionDigits: 2,
  });
  return `${formatter.format(bucket.spend.used)} / ${formatter.format(bucket.spend.limit)}`;
}

function formatProvider(provider: ProviderLimitsActualRoute["provider"]): string {
  return provider === "local" ? "Local Qwen" : provider === "claude" ? "Claude" : "Codex";
}

function ActualRoute({ route }: { readonly route: ProviderLimitsActualRoute }) {
  const requested = route.requestedProvider;
  const fallback =
    route.fallback && requested !== undefined
      ? ` (fallback from ${formatProvider(requested)})`
      : route.fallback
        ? " (fallback)"
        : "";
  const status = route.statusCode === undefined ? "" : `, HTTP ${route.statusCode}`;
  const at = new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(route.at);
  return (
    <p className="text-xs text-muted-foreground">
      Last request served by {formatProvider(route.provider)}
      {fallback} — {route.model}
      {status} at {at}
    </p>
  );
}

function BucketRows({ bucket }: { readonly bucket: ProviderLimitBucket }) {
  const windows = [bucket.primary, bucket.secondary].filter(
    (window): window is ProviderLimitBucket["primary"] => window !== undefined,
  );
  const spend = formatSpend(bucket);
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-foreground">{bucket.displayName}</div>
      {windows.map((window, index) => (
        <div key={`${window.label}-${index}`} className="space-y-1">
          <div className="flex justify-between gap-4 text-xs">
            <span className="truncate text-muted-foreground">
              {window.label} · {formatReset(window.resetsAt)}
            </span>
            <span className="shrink-0 tabular-nums">{Math.round(window.usedPercent)}% used</span>
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

function ProviderCard(props: {
  readonly provider: "claude" | "codex";
  readonly snapshot: ProviderLimitsSnapshot | undefined;
  readonly accountLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="text-sm font-medium capitalize">
          {props.provider}
          {props.accountLabel ? (
            <span className="ml-1 font-normal text-muted-foreground">· {props.accountLabel}</span>
          ) : null}
        </h4>
        <span className="text-xs text-muted-foreground">
          {props.snapshot?.planType ?? props.snapshot?.authState ?? "unavailable"}
        </span>
      </div>
      {props.snapshot?.buckets.length ? (
        <div className="space-y-3">
          {props.snapshot.buckets.map((bucket) => (
            <BucketRows key={bucket.bucketId} bucket={bucket} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No live quota reported.</p>
      )}
    </div>
  );
}

function providerAccountCounts(accounts: readonly ProviderLimitsAccountGroup[]) {
  return accounts.reduce(
    (counts, account) => ({ ...counts, [account.provider]: counts[account.provider] + 1 }),
    { claude: 0, codex: 0 },
  );
}

export function ProviderLimitsPanel() {
  const limits = useAllProviderLimits();
  const grouped = groupProviderLimits(limits.environments);
  const accountCounts = providerAccountCounts(grouped.accounts);
  return (
    <section
      aria-labelledby="live-quota-heading"
      className="mb-8 rounded-xl border border-border/60 bg-card/40 p-4"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="live-quota-heading" className="text-sm font-semibold">
            Live subscription quota
          </h2>
          <p className="text-xs text-muted-foreground">
            Current provider limits; shared OAuth accounts are shown once.
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={limits.refresh}
          aria-label="Refresh live subscription quota"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {grouped.accounts.length > 0 ? (
        <div className="space-y-3">
          <div className="grid gap-4 md:grid-cols-2">
            {grouped.accounts.map((account) => (
              <ProviderCard
                key={account.key}
                provider={account.provider}
                snapshot={account.snapshot}
                {...(accountCounts[account.provider] > 1 && account.accountId
                  ? { accountLabel: maskAccountId(account.accountId) }
                  : {})}
              />
            ))}
          </div>
          {grouped.lastActualRoute ? <ActualRoute route={grouped.lastActualRoute} /> : null}
          {grouped.errors.map((error) => (
            <p key={error} className="text-xs text-destructive">
              {error}
            </p>
          ))}
        </div>
      ) : grouped.isPending ? (
        <p className="text-xs text-muted-foreground">Loading live subscription quota…</p>
      ) : (
        <p className="text-xs text-muted-foreground">No live quota reported.</p>
      )}
    </section>
  );
}
