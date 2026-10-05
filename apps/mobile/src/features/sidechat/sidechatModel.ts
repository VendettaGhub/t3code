import {
  sidechatOriginPoint,
  type SidechatOrigin as ThreadOrigin,
} from "@t3tools/client-runtime/state/models";

type SidechatOrigin = Pick<ThreadOrigin, "threadId"> | { readonly threadId: string };

export type SidechatParentState = {
  readonly latestTurn: { readonly state: string } | null;
  readonly activeTurnId: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
};

export type SidechatStartResult =
  | { readonly allowed: true; readonly reason: null }
  | { readonly allowed: false; readonly reason: string };

export function sidechatChildren<
  T extends {
    readonly id: string;
    readonly origin?: SidechatOrigin | null;
  },
>(sourceThreadId: string, threads: readonly T[]): T[] {
  return threads.filter((thread) => thread.origin?.threadId === sourceThreadId);
}

export function resolveSidechatParent<T extends { readonly id: string }>(
  origin: SidechatOrigin | null | undefined,
  threads: readonly T[],
): T | null {
  if (origin === null || origin === undefined) return null;
  return threads.find((thread) => thread.id === origin.threadId) ?? null;
}

export function supportsNativeThreadFork(supportsThreadFork: boolean | null | undefined): boolean {
  return supportsThreadFork === true;
}

/** Bare side-question entry creates an empty child; only /btw text consumes a draft. */
export function shouldTransferSideQuestionDraft(question: string | null): boolean {
  return question !== null;
}

export function canCompleteSideQuestion(input: {
  readonly mounted: boolean;
  readonly focused: boolean;
  readonly currentOwnerKey: string | null;
  readonly ownerKey: string;
  readonly currentGeneration: number;
  readonly requestGeneration: number;
}): boolean {
  return (
    input.mounted &&
    input.focused &&
    input.currentOwnerKey === input.ownerKey &&
    input.currentGeneration === input.requestGeneration
  );
}

export function canStartSidechat(input: {
  readonly parent: SidechatParentState | null;
  readonly supportsThreadFork: boolean | null | undefined;
}): SidechatStartResult {
  if (input.parent === null) {
    return { allowed: false, reason: "The source thread is no longer available." };
  }

  if (!supportsNativeThreadFork(input.supportsThreadFork)) {
    return { allowed: false, reason: "This provider does not support native sidechats." };
  }

  if (input.parent.latestTurn == null) {
    return { allowed: false, reason: "Complete a source turn before starting a side question." };
  }

  return { allowed: true, reason: null };
}

export function formatSidechatOrigin(origin: ThreadOrigin): string {
  return `From source turn ${sidechatOriginPoint(origin)}`;
}
