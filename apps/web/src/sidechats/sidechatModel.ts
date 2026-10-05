/**
 * Sidechats: contract-shaped types and the web-side adapter seam.
 *
 * The fork/origin contract is owned by the contracts package. This module only
 * projects it into the web panel's view model.
 *
 * The deliberate rule for every state helper: when something is missing,
 * stale or busy, say so. A sidechat surface must never quietly degrade into
 * something that looks usable but writes nowhere.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ThreadId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  sidechatOriginPoint,
  type SidechatOrigin as ThreadOrigin,
} from "@t3tools/client-runtime/state/models";
import type { SidechatForkInput } from "@t3tools/client-runtime/operations";
export type { ThreadOrigin };
export type ThreadForkInput = SidechatForkInput;
export type ThreadForkResult = { readonly targetThreadId: ThreadId; readonly origin: ThreadOrigin };

/* -------------------------------------------------------------------------- */
/* Server-owned list entries                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One entry of the server-owned sidechat list. The list is unlimited; the panel
 * is a singleton index/detail surface over it, never one tab per sidechat.
 *
 * `targetThreadId` is null until the fork resolves. Until then the sidechat is
 * not addressable and the detail view must refuse to render a transcript
 * rather than invent one.
 */
export interface Sidechat {
  readonly id: string;
  readonly title: string;
  readonly origin: ThreadOrigin;
  readonly targetThreadId: string | null;
  readonly status: "pending" | "ready" | "failed";
  readonly updatedAt: string;
  /** Server-reported, presentational only. Absent while unknown. */
  readonly messageCount?: number;
}

export type SidechatListState =
  | { readonly kind: "unavailable"; readonly reason: SidechatUnavailableReason }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sidechats: ReadonlyArray<Sidechat> };

export type SidechatUnavailableReason =
  /** The client adapter is not wired for this surface. */
  | "not-wired"
  /** The environment's server does not expose the capability. */
  | "unsupported-environment"
  /** The call was made and failed. */
  | "failed";

/**
 * The single seam the panel talks to; it is backed by the environment RPC in
 * ChatView and remains explicit for unsupported environments.
 */
export interface SidechatAdapter {
  readonly list: SidechatListState;
  /**
   * Provider kinds whose native context can carry a sidechat. `null` means the
   * adapter cannot answer the question, which reads as unsupported — guessing
   * a provider list here is exactly the silent fallback this surface forbids.
   */
  readonly supportedProviders: ReadonlySet<ProviderDriverKind> | null;
  /** `null` while forking is not available. Never auto-invoked. */
  readonly fork: ((input: ThreadForkInput) => Promise<ThreadForkResult>) | null;
}

/** Projects the native fork threads in the shell snapshot into this panel's list. */
export function sidechatsForSource(
  shells: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "origin" | "title" | "updatedAt">
  >,
  sourceThreadRef: ScopedThreadRef,
): ReadonlyArray<Sidechat> {
  return shells
    .filter(
      (shell) =>
        shell.environmentId === sourceThreadRef.environmentId &&
        shell.origin?.threadId === sourceThreadRef.threadId,
    )
    .map((shell) => ({
      id: shell.id,
      title: shell.title,
      origin: shell.origin!,
      targetThreadId: shell.id,
      status: "ready" as const,
      updatedAt: shell.updatedAt,
    }));
}

/** A child sidechat always forks the latest completed turn of its main thread. */
export function resolveSidechatSourceThreadRef(
  activeThreadRef: ScopedThreadRef | null,
  origin: Pick<ThreadOrigin, "threadId"> | null,
): ScopedThreadRef | null {
  if (activeThreadRef === null) return null;
  return origin === null
    ? activeThreadRef
    : scopeThreadRef(activeThreadRef.environmentId, origin.threadId);
}

export const UNAVAILABLE_SIDECHAT_ADAPTER: SidechatAdapter = {
  list: { kind: "unavailable", reason: "not-wired" },
  supportedProviders: null,
  fork: null,
};

/* -------------------------------------------------------------------------- */
/* View state                                                                  */
/* -------------------------------------------------------------------------- */

export type SidechatBlockedReason =
  | "backend-unavailable"
  | "provider-unsupported"
  | "no-source-thread"
  | "source-incomplete";

export type SidechatLaunchState =
  | { readonly kind: "ready" }
  | {
      readonly kind: "blocked";
      readonly reason: SidechatBlockedReason;
      readonly message: string;
    };

const BLOCKED_MESSAGES: Record<SidechatBlockedReason, string> = {
  "backend-unavailable": "Sidechats are not available from this server yet.",
  "provider-unsupported": "This provider cannot carry a sidechat's context.",
  "no-source-thread": "Sidechats start from a saved thread.",
  "source-incomplete": "Start a sidechat from a completed turn.",
};

function blocked(reason: SidechatBlockedReason): SidechatLaunchState {
  return { kind: "blocked", reason, message: BLOCKED_MESSAGES[reason] };
}

/**
 * Whether a new sidechat can be started right now. Order matters: the most
 * structural reason wins, so a user on an unsupported provider is told that
 * rather than being sent to wait for a turn that would not help.
 */
export function resolveSidechatLaunchState(input: {
  adapter: SidechatAdapter;
  provider: ProviderDriverKind | null;
  sourceThreadRef: ScopedThreadRef | null;
  /** Latest visible turn; the server selects the most recent completed checkpoint. */
  sourceTurn: { readonly turnId: string; readonly completed: boolean } | null;
  mainThreadBusy: boolean;
}): SidechatLaunchState {
  if (input.adapter.list.kind === "unavailable" || input.adapter.fork === null) {
    return blocked("backend-unavailable");
  }
  if (
    input.provider === null ||
    input.adapter.supportedProviders === null ||
    !input.adapter.supportedProviders.has(input.provider)
  ) {
    return blocked("provider-unsupported");
  }
  if (input.sourceThreadRef === null) return blocked("no-source-thread");
  // Shells only include the latest turn; the server selects and validates the
  // last completed checkpoint even when a newer turn is running.
  if (input.sourceTurn === null) {
    return blocked("source-incomplete");
  }
  return { kind: "ready" };
}

export type SidechatDetailUnavailableReason =
  /** The fork has not produced an addressable thread yet. */
  | "no-target-thread"
  /** The selected id is no longer in the server-owned list. */
  | "stale-selection"
  /** The host did not supply a thread renderer, so there is nothing to mount. */
  | "no-thread-host"
  /** The fork failed server-side. */
  | "failed";

export type SidechatDetailState =
  | { readonly kind: "index" }
  | { readonly kind: "thread"; readonly sidechat: Sidechat; readonly threadRef: ScopedThreadRef }
  | {
      readonly kind: "unavailable";
      readonly sidechat: Sidechat | null;
      readonly reason: SidechatDetailUnavailableReason;
      readonly message: string;
    };

const DETAIL_MESSAGES: Record<SidechatDetailUnavailableReason, string> = {
  "no-target-thread": "This sidechat has no thread yet.",
  "stale-selection": "That sidechat is no longer in this thread's list.",
  "no-thread-host": "This build cannot open a sidechat transcript yet.",
  failed: "This sidechat could not be created.",
};

function detailUnavailable(
  sidechat: Sidechat | null,
  reason: SidechatDetailUnavailableReason,
): SidechatDetailState {
  return { kind: "unavailable", sidechat, reason, message: DETAIL_MESSAGES[reason] };
}

/**
 * Resolves what the detail pane should show. A stale id — the list moved on
 * while a sidechat was selected — is reported, not silently bounced back to the
 * index, because the two are different things to a reader.
 */
export function resolveSidechatDetailState(input: {
  environmentId: EnvironmentId | null;
  selectedSidechatId: string | null;
  sidechats: ReadonlyArray<Sidechat>;
  /** True when the host supplied a renderer for a real thread ref. */
  canRenderThread: boolean;
}): SidechatDetailState {
  if (input.selectedSidechatId === null) return { kind: "index" };
  const sidechat = input.sidechats.find((entry) => entry.id === input.selectedSidechatId) ?? null;
  if (sidechat === null) return detailUnavailable(null, "stale-selection");
  if (sidechat.status === "failed") return detailUnavailable(sidechat, "failed");
  const threadRef = sidechatThreadRef(input.environmentId, sidechat.targetThreadId);
  if (threadRef === null) return detailUnavailable(sidechat, "no-target-thread");
  if (!input.canRenderThread) return detailUnavailable(sidechat, "no-thread-host");
  return { kind: "thread", sidechat, threadRef };
}

/**
 * A sidechat becomes a normal addressable thread reference once the fork has a
 * `targetThreadId`. Before that there is no ref to build, and callers get null
 * rather than a placeholder that would address the wrong thread.
 */
export function sidechatThreadRef(
  environmentId: EnvironmentId | null,
  targetThreadId: string | null,
): ScopedThreadRef | null {
  if (environmentId === null) return null;
  if (targetThreadId === null || targetThreadId.trim().length === 0) return null;
  return scopeThreadRef(environmentId, ThreadId.make(targetThreadId));
}

export type SidechatWorkspaceNoticeLevel = "none" | "info" | "warning";

export interface SidechatWorkspaceNotice {
  readonly level: SidechatWorkspaceNoticeLevel;
  readonly message: string;
}

const SHARED_WORKSPACE_NOTICE =
  "Files are shared: concurrent edits can conflict. File restore may be unavailable while another thread uses this directory.";

/**
 * Sidechats run against the same working tree as their main thread. That is
 * worth saying once, quietly; it only becomes a warning while the main thread
 * is actually working, which is when concurrent edits can collide.
 */
export function resolveSidechatWorkspaceNotice(input: {
  workspaceShared: boolean;
  mainThreadBusy: boolean;
}): SidechatWorkspaceNotice {
  if (!input.workspaceShared) return { level: "none", message: "" };
  if (input.mainThreadBusy) {
    return {
      level: "warning",
      message: `The main thread is working in this same worktree. New side questions use its last completed turn, not the running turn. ${SHARED_WORKSPACE_NOTICE}`,
    };
  }
  return {
    level: "info",
    message: SHARED_WORKSPACE_NOTICE,
  };
}

export interface SidechatOriginDescription {
  /** Reader-facing sentence: what the sidechat forked from and how long ago. */
  readonly label: string;
  /** The exact origin identity, for tooltips, copying and assistive text. */
  readonly detail: string;
}

/**
 * The origin's turn id is a UUID and reads as noise in a header. Readers get
 * the plain fact and the time; the id stays one hover or copy away so the real
 * identity is never hidden.
 */
export function describeSidechatOrigin(origin: ThreadOrigin): SidechatOriginDescription {
  const when = formatRelativeTimeLabel(origin.createdAt);
  return {
    label: when.length > 0 ? `Forked from the main thread ${when}` : "Forked from the main thread",
    detail: `Origin turn ${sidechatOriginPoint(origin)}`,
  };
}

/** Index rows, newest activity first, with a stable tiebreak on id. */
export function orderSidechats(sidechats: ReadonlyArray<Sidechat>): ReadonlyArray<Sidechat> {
  return [...sidechats].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
