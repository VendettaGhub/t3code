/**
 * Sidechats right-panel surface: one index/detail pane per main thread.
 *
 * Deliberate boundaries:
 * - The list is server-owned and unlimited; this surface is a singleton, so a
 *   sidechat is a row here, never a tab of its own.
 * - The main transcript is never copied or re-rendered here. A sidechat's
 *   context comes from the provider's native fork; this panel only shows the
 *   sidechat's own thread, and only through the host's renderer once a stable
 *   target thread ref exists.
 * - Every missing piece — no backend, unsupported provider, busy or incomplete
 *   source turn, stale selection — is visible. Nothing degrades quietly.
 *
 * Row visuals follow AgentsPanel: quiet, fixed-height, status-dot rows that do
 * not move as data arrives.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProviderDriverKind, ScopedThreadRef } from "@t3tools/contracts";
import {
  ArrowUpRight,
  CheckIcon,
  ChevronLeft,
  CopyIcon,
  HistoryIcon,
  InfoIcon,
  MessagesSquare,
  Quote,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { sidechatOriginPoint } from "@t3tools/client-runtime/state/models";
import { newThreadId } from "~/lib/utils";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "~/components/ui/anchoredCopyToast";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  appendSidechatExcerptToMainDraft,
  type SidechatExcerptAppendResult,
  type SidechatExcerptSource,
} from "~/sidechats/sidechatExcerpt";
import {
  describeSidechatOrigin,
  orderSidechats,
  resolveSidechatDetailState,
  resolveSidechatLaunchState,
  resolveSidechatWorkspaceNotice,
  type Sidechat,
  type SidechatAdapter,
  type ThreadOrigin,
} from "~/sidechats/sidechatModel";

const STATUS_DOT_CLASS: Record<Sidechat["status"], string> = {
  pending: "bg-info",
  ready: "bg-success",
  failed: "bg-destructive",
};

const STATUS_LABEL: Record<Sidechat["status"], string> = {
  pending: "Starting",
  ready: "Ready",
  failed: "Failed",
};

export interface SidechatsPanelProps {
  /** The only route to the backend. Defaults to the unavailable adapter. */
  adapter: SidechatAdapter;
  provider: ProviderDriverKind | null;
  environmentId: EnvironmentId | null;
  /** The main thread this surface belongs to. */
  sourceThreadRef: ScopedThreadRef | null;
  /** The main thread's draft, which excerpts are appended to. */
  composerDraftTarget: ComposerThreadTarget | null;
  /** The turn a new sidechat would fork from. */
  sourceTurn: { readonly turnId: string; readonly completed: boolean } | null;
  mainThreadBusy: boolean;
  workspaceShared: boolean;
  /** The selected row is surface state so it survives panel remounts. */
  selectedSidechatId: string | null;
  onSelectSidechat: (sidechatId: string | null) => void;
  /** A one-shot user entry request; it never comes from persisted panel state. */
  startRequestId?: number;
  /** Optional question captured by the one-shot entry request. */
  startRequestQuestion?: string | null;
  onStartRequestConsumed?: () => void;
  /** Runs after the native fork exists; failures remain visible in this panel. */
  onForked?: (input: { sidechat: Sidechat; question: string | null }) => void | Promise<void>;
  /** Closes the right panel without touching the native fork history. */
  onClose?: () => void;
  /** Runs after an excerpt is appended, for standalone sidechat return navigation. */
  onExcerptAppended?: () => void;
  /**
   * Takes the reader to the origin turn in the main thread. Optional because
   * there is no transcript-reveal API yet; without it the origin renders as a
   * plain reference rather than a link that would go nowhere.
   */
  onRevealOrigin?: ((origin: ThreadOrigin) => void) | undefined;
  /**
   * Mounts the sidechat's own thread — the normal ChatView/ChatComposer stack —
   * for a stable thread ref. Without it the detail view says so instead of
   * improvising a transcript.
   */
  renderSidechatThread?: ((threadRef: ScopedThreadRef) => ReactNode) | undefined;
  /**
   * Resolves what the reader has selected in the sidechat transcript. Hosts
   * whose transcript knows its message ids supply this; the fallback reads the
   * plain text selection inside the detail pane.
   */
  resolveExcerpt?:
    | (() => Pick<SidechatExcerptSource, "messageId" | "authorLabel" | "text"> | null)
    | undefined;
}

function PanelMessage(props: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <MessagesSquare aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{props.title}</p>
      <p className="max-w-56 text-xs text-muted-foreground">{props.detail}</p>
      {props.children}
    </div>
  );
}

/**
 * Compact, non-blocking strip. It wraps rather than truncates because the
 * restore limitation is the part readers need most, and escalates to the
 * shared warning treatment only while the main thread works.
 */
export function WorkspaceNotice(props: { workspaceShared: boolean; mainThreadBusy: boolean }) {
  const notice = resolveSidechatWorkspaceNotice(props);
  if (notice.level === "none") return null;
  const Icon = notice.level === "warning" ? TriangleAlertIcon : InfoIcon;
  return (
    <p
      role="note"
      data-sidechat-workspace-notice={notice.level}
      className={cn(
        "flex shrink-0 items-start gap-1.5 border-b border-border/60 px-3 py-1.5 text-xs leading-snug",
        notice.level === "warning"
          ? "bg-warning-surface text-warning-foreground [&_svg]:text-warning"
          : "text-muted-foreground [&_svg]:text-muted-foreground/70",
      )}
    >
      <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{notice.message}</span>
    </p>
  );
}

/** The exact origin id stays one click away without being printed in the header. */
function OriginIdCopyButton(props: { value: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Copy origin turn id"
            disabled={isCopied}
            onClick={() => copyToClipboard(props.value, undefined)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <p className="font-mono">{props.value}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

function SidechatRow(props: { sidechat: Sidechat; onResume: () => void }) {
  const { sidechat } = props;
  const openable = sidechat.status !== "failed";
  return (
    <div
      className={cn(
        "grid min-h-[2.75rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left",
        openable ? "hover:bg-accent/40" : "opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "col-start-1 row-start-1 size-1.5 shrink-0 rounded-full",
          STATUS_DOT_CLASS[sidechat.status],
        )}
      />
      <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
        {sidechat.title}
      </span>
      <span className="col-start-3 row-start-1 shrink-0 font-mono text-sidechat text-muted-foreground/80">
        {STATUS_LABEL[sidechat.status]}
      </span>
      <Button
        type="button"
        size="micro"
        variant="ghost-muted"
        className="col-start-3 row-start-2"
        onClick={props.onResume}
        disabled={!openable}
        aria-label={`Resume sidechat ${sidechat.title}`}
      >
        Resume
      </Button>
      <span className="col-start-2 col-end-3 row-start-2 truncate text-sidechat tabular-nums text-muted-foreground/70">
        {[
          sidechat.messageCount === undefined ? null : `${sidechat.messageCount} messages`,
          describeSidechatOrigin(sidechat.origin).label,
        ]
          .filter((value): value is string => value !== null)
          .join(", ")}
      </span>
    </div>
  );
}

/**
 * Title on the first line, origin on the second. The title may wrap to two
 * lines; the origin is a plain sentence that acts as a link when the host can
 * reveal the turn, with the exact turn id kept in the tooltip and copy action.
 * Extra host controls (children) share the origin line and wrap below it
 * before they collide at narrow widths.
 */
export function SidechatOriginHeader(props: {
  origin: ThreadOrigin;
  onRevealOrigin: ((origin: ThreadOrigin) => void) | undefined;
  onBack: () => void;
  title: string;
  backAriaLabel?: string;
  backLabel?: string;
  backDisabled?: boolean;
  children?: ReactNode;
}) {
  const origin = describeSidechatOrigin(props.origin);
  const originClassName =
    "flex min-w-0 items-center gap-1 rounded-sm px-1 text-sidechat leading-4 text-muted-foreground";
  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-start gap-1.5">
        <Button
          size={props.backLabel ? "compact" : "icon-xs"}
          variant="ghost-muted"
          className="-mt-0.5"
          onClick={props.onBack}
          disabled={props.backDisabled}
          aria-label={props.backAriaLabel ?? "All sidechats"}
        >
          <ChevronLeft aria-hidden className="size-3.5" />
          {props.backLabel ? <span>{props.backLabel}</span> : null}
        </Button>
        <h2 className="min-w-0 flex-1 text-sm font-medium leading-5 line-clamp-2 break-words">
          {props.title}
        </h2>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ps-sidechat-origin">
        <span className="flex min-w-0 items-center gap-0.5">
          {props.onRevealOrigin ? (
            <button
              type="button"
              onClick={() => props.onRevealOrigin?.(props.origin)}
              aria-label={`${origin.label}. ${origin.detail}. Show the origin turn`}
              className={cn(
                originClassName,
                "cursor-pointer underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              )}
            >
              <span className="truncate">{origin.label}</span>
              <ArrowUpRight aria-hidden className="size-3 shrink-0" />
            </button>
          ) : (
            <span className={originClassName}>
              <span className="truncate">{origin.label}</span>
              <span className="sr-only">. {origin.detail}</span>
            </span>
          )}
          <OriginIdCopyButton value={sidechatOriginPoint(props.origin)} />
        </span>
        {props.children ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
            {props.children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SidechatsPanel(props: SidechatsPanelProps) {
  const [pendingSidechat, setPendingSidechat] = useState<Sidechat | null>(null);
  const [forking, setForking] = useState(false);
  const [directForking, setDirectForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const forkRequestIdRef = useRef(new Map<string, string>());
  const forkInFlightRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  const sourceThreadKeyRef = useRef<string | null>(null);
  const forkGenerationRef = useRef(0);
  const directStartOpenRef = useRef(false);
  const consumedStartRequestRef = useRef<{
    requestId: number;
    sourceThreadKey: string | null;
  } | null>(null);
  const [excerptResult, setExcerptResult] = useState<SidechatExcerptAppendResult | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const sourceThreadKey =
    props.sourceThreadRef === null ? null : scopedThreadKey(props.sourceThreadRef);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const previousSourceThreadKey = sourceThreadKeyRef.current;
    sourceThreadKeyRef.current = sourceThreadKey;
    if (previousSourceThreadKey === sourceThreadKey) return;
    forkGenerationRef.current += 1;
    consumedStartRequestRef.current = null;
    setPendingSidechat(null);
    setForking(false);
    setDirectForking(false);
    directStartOpenRef.current = false;
    setForkError(null);
  }, [sourceThreadKey]);

  const launch = resolveSidechatLaunchState({
    adapter: props.adapter,
    provider: props.provider,
    sourceThreadRef: props.sourceThreadRef,
    sourceTurn: props.sourceTurn,
    mainThreadBusy: props.mainThreadBusy,
  });

  const sidechats =
    props.adapter.list.kind === "ready"
      ? pendingSidechat === null ||
        props.adapter.list.sidechats.some((entry) => entry.id === pendingSidechat.id)
        ? props.adapter.list.sidechats
        : [...props.adapter.list.sidechats, pendingSidechat]
      : pendingSidechat === null
        ? []
        : [pendingSidechat];
  const selectedSidechatId = props.selectedSidechatId;
  const selectedSidechatStillExists =
    selectedSidechatId === null || sidechats.some((entry) => entry.id === selectedSidechatId);
  useEffect(() => {
    if (
      props.adapter.list.kind === "ready" &&
      selectedSidechatId !== null &&
      !selectedSidechatStillExists
    ) {
      props.onSelectSidechat(null);
    }
  }, [
    props.adapter.list.kind,
    props.onSelectSidechat,
    selectedSidechatId,
    selectedSidechatStillExists,
  ]);
  const detail = resolveSidechatDetailState({
    environmentId: props.environmentId,
    selectedSidechatId: selectedSidechatStillExists ? selectedSidechatId : null,
    sidechats,
    canRenderThread: props.renderSidechatThread !== undefined,
  });

  const startSidechat = useCallback(
    async (direct = true, question: string | null = null) => {
      const sourceThreadRef = props.sourceThreadRef;
      const sourceThreadKey = sourceThreadRef === null ? null : scopedThreadKey(sourceThreadRef);
      if (
        launch.kind !== "ready" ||
        props.adapter.fork === null ||
        sourceThreadRef === null ||
        sourceThreadKey === null ||
        forkInFlightRef.current.has(sourceThreadKey)
      ) {
        return;
      }
      setForkError(null);
      const forkGeneration = forkGenerationRef.current;
      if (direct) props.onSelectSidechat(null);
      setForking(true);
      if (direct) {
        directStartOpenRef.current = true;
        setDirectForking(true);
      }
      forkInFlightRef.current.add(sourceThreadKey);
      try {
        const requestId = forkRequestIdRef.current.get(sourceThreadKey) ?? newThreadId();
        forkRequestIdRef.current.set(sourceThreadKey, requestId);
        const result = await props.adapter.fork({
          sourceThreadId: sourceThreadRef.threadId,
          requestId,
        });
        forkRequestIdRef.current.delete(sourceThreadKey);
        // A route switch may have mounted another main thread while the native
        // fork was resolving. Never select the result in that other thread.
        if (
          !mountedRef.current ||
          sourceThreadKeyRef.current !== sourceThreadKey ||
          forkGenerationRef.current !== forkGeneration
        ) {
          return;
        }
        const next: Sidechat = {
          id: result.targetThreadId,
          title: "Side question",
          origin: result.origin,
          targetThreadId: result.targetThreadId,
          status: "ready",
          updatedAt: result.origin.createdAt,
        };
        setPendingSidechat(next);
        await props.onForked?.({ sidechat: next, question });
        if (
          !mountedRef.current ||
          sourceThreadKeyRef.current !== sourceThreadKey ||
          forkGenerationRef.current !== forkGeneration
        ) {
          return;
        }
        setDirectForking(false);
        if (directStartOpenRef.current) props.onSelectSidechat(next.id);
      } catch (error) {
        if (
          mountedRef.current &&
          sourceThreadKeyRef.current === sourceThreadKey &&
          forkGenerationRef.current === forkGeneration
        ) {
          setDirectForking(false);
          setForkError(
            error instanceof Error ? error.message : "The side question could not be created.",
          );
        }
      } finally {
        forkInFlightRef.current.delete(sourceThreadKey);
        if (
          mountedRef.current &&
          sourceThreadKeyRef.current === sourceThreadKey &&
          forkGenerationRef.current === forkGeneration
        ) {
          setForking(false);
        }
      }
    },
    [launch.kind, props.adapter, props.onForked, props.onSelectSidechat, props.sourceThreadRef],
  );

  useEffect(() => {
    const requestId = props.startRequestId;
    if (requestId === undefined || requestId <= 0) {
      if (consumedStartRequestRef.current?.sourceThreadKey === sourceThreadKey) {
        consumedStartRequestRef.current = null;
      }
      return;
    }
    if (
      consumedStartRequestRef.current?.requestId === requestId &&
      consumedStartRequestRef.current.sourceThreadKey === sourceThreadKey
    ) {
      return;
    }
    consumedStartRequestRef.current = { requestId, sourceThreadKey };
    props.onStartRequestConsumed?.();
    if (launch.kind !== "ready") {
      props.onSelectSidechat(null);
      setForkError(launch.message);
      return;
    }
    void startSidechat(true, props.startRequestQuestion ?? null);
  }, [
    launch,
    props.onStartRequestConsumed,
    props.startRequestId,
    props.startRequestQuestion,
    sourceThreadKey,
    startSidechat,
  ]);

  const { resolveExcerpt } = props;
  const closePanel = useCallback(() => {
    directStartOpenRef.current = false;
    setDirectForking(false);
    props.onClose?.();
  }, [props.onClose]);
  const appendExcerpt = useCallback(
    (sidechat: Sidechat) => {
      const resolved =
        resolveExcerpt?.() ??
        // Fallback for a transcript this panel does not own: quote whatever the
        // reader has selected inside the detail pane. "selection" stands in for
        // a message id because a raw selection does not carry one.
        (() => {
          const container = detailRef.current;
          const selection = container?.ownerDocument.getSelection() ?? null;
          // Scoped to the detail pane: a selection left in the main transcript
          // must not be quoted back as if it came from the sidechat.
          const anchor = selection?.anchorNode ?? null;
          const focus = selection?.focusNode ?? null;
          const inside =
            container !== null &&
            anchor !== null &&
            focus !== null &&
            container.contains(anchor) &&
            container.contains(focus);
          return {
            messageId: "selection",
            authorLabel: "Sidechat",
            text: inside ? (selection?.toString() ?? "") : "",
          };
        })();
      const result = appendSidechatExcerptToMainDraft({
        target: props.composerDraftTarget,
        source: {
          sidechatId: sidechat.id,
          sidechatTitle: sidechat.title,
          origin: sidechat.origin,
          ...resolved,
        },
        addReviewComment,
      });
      setExcerptResult(result);
      if (result.kind === "appended") {
        closePanel();
        props.onExcerptAppended?.();
      }
    },
    [
      addReviewComment,
      closePanel,
      props.composerDraftTarget,
      props.onExcerptAppended,
      resolveExcerpt,
    ],
  );

  if (props.adapter.list.kind === "unavailable") {
    return (
      <PanelMessage
        title="Sidechats unavailable"
        detail={
          props.adapter.list.reason === "unsupported-environment"
            ? "Update this environment's T3 Code server to use sidechats."
            : props.adapter.list.reason === "failed"
              ? "This thread's sidechats could not be loaded."
              : "This build cannot reach the sidechat service yet."
        }
      />
    );
  }

  if (directForking) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <WorkspaceNotice
          workspaceShared={props.workspaceShared}
          mainThreadBusy={props.mainThreadBusy}
        />
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => {
              directStartOpenRef.current = false;
              setDirectForking(false);
              props.onSelectSidechat(null);
            }}
            aria-label="History"
          >
            <HistoryIcon aria-hidden className="size-3.5" />
            History
          </Button>
          <h2 className="min-w-0 flex-1 text-center text-sm font-medium">Side question</h2>
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={closePanel}
            disabled={props.onClose === undefined}
          >
            Close
          </Button>
        </div>
        <PanelMessage
          title="Starting side question…"
          detail="Forking the latest completed main turn. The main thread stays visible."
        />
      </div>
    );
  }

  if (detail.kind === "unavailable") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <WorkspaceNotice
          workspaceShared={props.workspaceShared}
          mainThreadBusy={props.mainThreadBusy}
        />
        <PanelMessage title="Sidechat unavailable" detail={detail.message}>
          <Button size="sm" variant="ghost-muted" onClick={() => props.onSelectSidechat(null)}>
            All sidechats
          </Button>
        </PanelMessage>
      </div>
    );
  }

  if (detail.kind === "thread") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <SidechatOriginHeader
          origin={detail.sidechat.origin}
          onRevealOrigin={props.onRevealOrigin}
          onBack={() => {
            props.onSelectSidechat(null);
            setExcerptResult(null);
          }}
          title={detail.sidechat.title}
          backAriaLabel="History"
          backLabel="History"
        >
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => void startSidechat()}
            disabled={launch.kind !== "ready" || forking}
          >
            <MessagesSquare aria-hidden className="size-3.5" />
            New side question
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={closePanel}
            disabled={props.onClose === undefined}
          >
            Close
          </Button>
        </SidechatOriginHeader>
        <WorkspaceNotice
          workspaceShared={props.workspaceShared}
          mainThreadBusy={props.mainThreadBusy}
        />
        <div ref={detailRef} className="flex min-h-0 flex-1 flex-col">
          {props.renderSidechatThread?.(detail.threadRef)}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => appendExcerpt(detail.sidechat)}
            disabled={props.composerDraftTarget === null}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Quote aria-hidden className="size-3.5" />
            Use selection &amp; return
          </Button>
          <span
            aria-live="polite"
            className={cn(
              "min-w-0 flex-1 truncate text-sidechat",
              excerptResult?.kind === "refused"
                ? "text-destructive-foreground"
                : "text-muted-foreground",
            )}
          >
            {excerptResult === null
              ? ""
              : excerptResult.kind === "appended"
                ? "Added to the main thread's draft."
                : excerptResult.message}
          </span>
        </div>
      </div>
    );
  }

  const ordered = orderSidechats(sidechats);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceNotice
        workspaceShared={props.workspaceShared}
        mainThreadBusy={props.mainThreadBusy}
      />
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <HistoryIcon aria-hidden className="size-3.5 text-muted-foreground" />
            History
          </p>
          <p className="truncate text-sidechat text-muted-foreground">
            Resume a previous side question or start a fresh one.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={() => void startSidechat()}
          disabled={launch.kind !== "ready" || forking}
          aria-label="Start sidechat"
        >
          <MessagesSquare aria-hidden className="size-3.5" />
          {forking ? "Starting…" : "New side question"}
        </Button>
      </div>
      {forkError ? (
        <p
          role="alert"
          className="shrink-0 border-b border-border/60 px-3 py-1.5 text-xs text-destructive-foreground"
        >
          {forkError}
        </p>
      ) : null}
      {ordered.length === 0 ? (
        <PanelMessage
          title={props.adapter.list.kind === "loading" ? "Loading sidechats…" : "No sidechats yet"}
          detail={
            launch.kind === "blocked"
              ? launch.message
              : "Start one from a completed turn to explore a tangent without moving this thread."
          }
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 p-2">
            {ordered.map((sidechat) => (
              <SidechatRow
                key={sidechat.id}
                sidechat={sidechat}
                onResume={() => {
                  props.onSelectSidechat(sidechat.id);
                  setExcerptResult(null);
                }}
              />
            ))}
          </div>
        </ScrollArea>
      )}
      {launch.kind === "blocked" && ordered.length > 0 ? (
        <p className="shrink-0 truncate border-t border-border/60 px-3 py-1.5 text-sidechat text-muted-foreground">
          {launch.message}
        </p>
      ) : null}
    </div>
  );
}
