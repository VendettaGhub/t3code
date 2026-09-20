import {
  ThreadId,
  TurnId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ addReviewComment: vi.fn() }));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/components/ui/anchoredCopyToast", () => ({
  ANCHORED_COPY_TOAST_TIMEOUT_MS: 1,
  showAnchoredCopyErrorToast: vi.fn(),
  showAnchoredCopySuccessToast: vi.fn(),
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));

import { SidechatsPanel, type SidechatsPanelProps } from "./SidechatsPanel";
import type { Sidechat, SidechatAdapter } from "~/sidechats/sidechatModel";

const environmentId = "env-1" as EnvironmentId;
const sourceThreadRef: ScopedThreadRef = {
  environmentId,
  threadId: ThreadId.make("main"),
};
const origin = {
  threadId: ThreadId.make("main"),
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-09-01T00:00:00.000Z",
} as const;
const existingSidechat: Sidechat = {
  id: "side-1",
  title: "Earlier question",
  origin,
  targetThreadId: ThreadId.make("side-1"),
  status: "ready",
  updatedAt: "2026-09-01T00:01:00.000Z",
};

function adapter(
  fork: SidechatAdapter["fork"] = async () => ({ targetThreadId: ThreadId.make("side-1"), origin }),
): SidechatAdapter {
  return {
    list: { kind: "ready", sidechats: [existingSidechat] },
    supportedProviders: new Set<ProviderDriverKind>(["claude" as ProviderDriverKind]),
    fork,
  };
}

function props(overrides: Partial<SidechatsPanelProps> = {}): SidechatsPanelProps {
  return {
    adapter: adapter(),
    provider: "claude" as ProviderDriverKind,
    environmentId,
    sourceThreadRef,
    composerDraftTarget: sourceThreadRef,
    sourceTurn: { turnId: "turn-1", completed: true },
    mainThreadBusy: false,
    workspaceShared: false,
    selectedSidechatId: null,
    onSelectSidechat: vi.fn(),
    renderSidechatThread: (threadRef: ScopedThreadRef) => (
      <p data-thread={String(threadRef.threadId)}>sidechat transcript</p>
    ),
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.addReviewComment.mockReset();
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("short sidequestion panel flow", () => {
  it("forks once for a direct entry even when effects are replayed", async () => {
    let resolveFork!: (value: { targetThreadId: ThreadId; origin: typeof origin }) => void;
    const fork = vi.fn(
      () =>
        new Promise<{ targetThreadId: ThreadId; origin: typeof origin }>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const onSelectSidechat = vi.fn();
    const onStartRequestConsumed = vi.fn();
    const view = props({
      adapter: adapter(fork),
      startRequestId: 1,
      onSelectSidechat,
      onStartRequestConsumed,
    });

    await act(async () => {
      renderer = create(
        <StrictMode>
          <SidechatsPanel {...view} />
        </StrictMode>,
      );
    });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(onStartRequestConsumed).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFork({ targetThreadId: ThreadId.make("side-new"), origin });
    });
    expect(onSelectSidechat).toHaveBeenCalledWith("side-new");
  });

  it("passes the captured question only after the native fork succeeds", async () => {
    const onForked = vi.fn();
    const view = props({
      adapter: adapter(async () => ({ targetThreadId: ThreadId.make("side-new"), origin })),
      startRequestId: 1,
      startRequestQuestion: "Explain the retry path",
      onForked,
    });

    await act(async () => {
      renderer = create(<SidechatsPanel {...view} />);
    });

    expect(onForked).toHaveBeenCalledWith({
      sidechat: expect.objectContaining({ targetThreadId: ThreadId.make("side-new") }),
      question: "Explain the retry path",
    });
  });

  it("keeps a child-send failure visible without selecting or falling through", async () => {
    const onForked = vi.fn().mockRejectedValue(new Error("child send failed"));
    const onSelectSidechat = vi.fn();
    const view = props({
      adapter: adapter(async () => ({ targetThreadId: ThreadId.make("side-new"), origin })),
      startRequestId: 1,
      startRequestQuestion: "Keep this question",
      onForked,
      onSelectSidechat,
    });

    await act(async () => {
      renderer = create(<SidechatsPanel {...view} />);
    });

    expect(renderer!.root.findByProps({ role: "alert" }).children.join(" ")).toContain(
      "child send failed",
    );
    expect(onSelectSidechat).not.toHaveBeenCalledWith("side-new");
  });

  it("does not select a child after its send resolves for a switched source", async () => {
    let resolveChildSend!: () => void;
    const onForked = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChildSend = resolve;
        }),
    );
    const onSelectSidechat = vi.fn();
    const view = props({
      adapter: adapter(async () => ({ targetThreadId: ThreadId.make("side-new"), origin })),
      startRequestId: 1,
      startRequestQuestion: "Keep this question",
      onForked,
      onSelectSidechat,
    });

    await act(async () => {
      renderer = create(<SidechatsPanel {...view} />);
    });
    expect(onForked).toHaveBeenCalledTimes(1);

    const nextThreadRef: ScopedThreadRef = {
      environmentId,
      threadId: ThreadId.make("next-main"),
    };
    await act(async () => {
      renderer?.update(
        <SidechatsPanel
          {...props({
            adapter: adapter(),
            sourceThreadRef: nextThreadRef,
            onSelectSidechat: vi.fn(),
            startRequestId: 0,
          })}
        />,
      );
    });
    await act(async () => resolveChildSend());

    expect(onSelectSidechat).not.toHaveBeenCalledWith("side-new");
  });

  it("closes only after a non-empty selection is appended", async () => {
    const onClose = vi.fn();
    const onExcerptAppended = vi.fn();
    const view = props({
      selectedSidechatId: existingSidechat.id,
      onClose,
      onExcerptAppended,
      resolveExcerpt: () => ({
        messageId: "message-1",
        authorLabel: "Assistant",
        text: "Keep the native fork.",
      }),
    });
    await act(async () => {
      renderer = create(<SidechatsPanel {...view} />);
    });
    const transfer = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Use selection & return"));
    expect(transfer).toBeDefined();

    await act(async () => transfer?.props.onClick());
    expect(state.addReviewComment).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onExcerptAppended).toHaveBeenCalledTimes(1);
  });

  it("clears an old detail before a fresh fork and keeps failure or blocked status visible", async () => {
    let rejectFork!: (reason?: unknown) => void;
    const fork = vi.fn(
      () =>
        new Promise<{ targetThreadId: ThreadId; origin: typeof origin }>((_, reject) => {
          rejectFork = reject;
        }),
    );
    const onSelectSidechat = vi.fn();
    const firstView = props({
      adapter: adapter(fork),
      selectedSidechatId: existingSidechat.id,
      startRequestId: 1,
      onSelectSidechat,
    });
    await act(async () => {
      renderer = create(<SidechatsPanel {...firstView} />);
    });
    expect(onSelectSidechat).toHaveBeenCalledWith(null);
    await act(async () => rejectFork(new Error("temporary fork failure")));
    await act(async () => {
      renderer?.update(
        <SidechatsPanel {...firstView} selectedSidechatId={null} startRequestId={0} />,
      );
    });
    expect(renderer!.root.findByProps({ role: "alert" }).children.join(" ")).toContain(
      "temporary fork failure",
    );
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.children.includes("Use selection & return")),
    ).toBe(false);

    const blockedView = props({
      adapter: adapter(fork),
      selectedSidechatId: existingSidechat.id,
      startRequestId: 2,
      mainThreadBusy: true,
      onSelectSidechat,
    });
    await act(async () => renderer?.update(<SidechatsPanel {...blockedView} />));
    expect(onSelectSidechat).toHaveBeenCalledTimes(2);
    expect(onSelectSidechat).toHaveBeenLastCalledWith(null);
    await act(async () => {
      renderer?.update(
        <SidechatsPanel {...blockedView} selectedSidechatId={null} startRequestId={0} />,
      );
    });
    expect(renderer!.root.findByProps({ role: "alert" }).children.join(" ")).toContain(
      "Wait for this thread's current turn to finish",
    );
  });

  it("does not select a late fork result after switching the main thread", async () => {
    let resolveFork!: (value: { targetThreadId: ThreadId; origin: typeof origin }) => void;
    const fork = vi.fn(
      () =>
        new Promise<{ targetThreadId: ThreadId; origin: typeof origin }>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const oldSelect = vi.fn();
    const nextSelect = vi.fn();
    const view = props({ adapter: adapter(fork), startRequestId: 1, onSelectSidechat: oldSelect });
    await act(async () => {
      renderer = create(<SidechatsPanel {...view} />);
    });
    const nextThreadRef: ScopedThreadRef = {
      environmentId,
      threadId: ThreadId.make("next-main"),
    };
    await act(async () => {
      renderer?.update(
        <SidechatsPanel
          {...props({
            adapter: adapter(fork),
            sourceThreadRef: nextThreadRef,
            onSelectSidechat: nextSelect,
            startRequestId: 0,
          })}
        />,
      );
    });
    await act(async () => {
      resolveFork({ targetThreadId: ThreadId.make("late-side"), origin });
    });
    expect(oldSelect).not.toHaveBeenCalledWith("late-side");
    expect(nextSelect).not.toHaveBeenCalledWith("late-side");
    const newQuestion = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("New side question"));
    expect(newQuestion?.props.disabled).not.toBe(true);
  });

  it("ignores a pending completion after unmount before a remounted Resume", async () => {
    let resolveFork!: (value: { targetThreadId: ThreadId; origin: typeof origin }) => void;
    const fork = vi.fn(
      () =>
        new Promise<{ targetThreadId: ThreadId; origin: typeof origin }>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const oldSelect = vi.fn();
    await act(async () => {
      renderer = create(
        <SidechatsPanel
          {...props({ adapter: adapter(fork), startRequestId: 1, onSelectSidechat: oldSelect })}
        />,
      );
    });
    expect(fork).toHaveBeenCalledTimes(1);
    act(() => renderer?.unmount());
    renderer = undefined;

    const newSelect = vi.fn();
    await act(async () => {
      renderer = create(
        <SidechatsPanel {...props({ adapter: adapter(fork), onSelectSidechat: newSelect })} />,
      );
    });
    const resume = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Resume"));
    await act(async () => resume?.props.onClick());
    expect(newSelect).toHaveBeenCalledWith(existingSidechat.id);

    await act(async () => resolveFork({ targetThreadId: ThreadId.make("late-side"), origin }));
    expect(oldSelect).not.toHaveBeenCalledWith("late-side");
    expect(newSelect).toHaveBeenCalledTimes(1);
  });

  it("retires a successful request id before an A-to-B-to-A route switch", async () => {
    type ForkInput = Parameters<NonNullable<SidechatAdapter["fork"]>>[0];
    type ForkResult = { targetThreadId: ThreadId; origin: typeof origin };
    const pending: Array<{
      sourceThreadId: string;
      requestId: string;
      resolve: (value: ForkResult) => void;
    }> = [];
    const fork = vi.fn(
      (input: ForkInput) =>
        new Promise<ForkResult>((resolve) => {
          pending.push({
            sourceThreadId: String(input.sourceThreadId),
            requestId: input.requestId,
            resolve,
          });
        }),
    );
    const onSelectSidechat = vi.fn();
    const threadB: ScopedThreadRef = { environmentId, threadId: ThreadId.make("thread-b") };

    await act(async () => {
      renderer = create(
        <SidechatsPanel
          {...props({ adapter: adapter(fork), startRequestId: 1, onSelectSidechat })}
        />,
      );
    });
    const first = pending[0];
    if (!first) throw new Error("expected the first fork request");
    expect(first.sourceThreadId).toBe("main");

    await act(async () => {
      renderer?.update(
        <SidechatsPanel
          {...props({
            adapter: adapter(fork),
            sourceThreadRef: threadB,
            startRequestId: 0,
            onSelectSidechat,
          })}
        />,
      );
    });
    await act(async () => first.resolve({ targetThreadId: ThreadId.make("old-side"), origin }));

    await act(async () => {
      renderer?.update(
        <SidechatsPanel
          {...props({ adapter: adapter(fork), startRequestId: 1, onSelectSidechat })}
        />,
      );
    });
    expect(fork).toHaveBeenCalledTimes(2);
    const second = pending[1];
    if (!second) throw new Error("expected the second fork request");
    expect(second.sourceThreadId).toBe("main");
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("shows a blocked direct entry as a retryable status", async () => {
    const fork = vi.fn(adapter().fork!);
    const onSelectSidechat = vi.fn();
    await act(async () => {
      renderer = create(
        <SidechatsPanel
          {...props({
            adapter: adapter(fork),
            mainThreadBusy: true,
            startRequestId: 1,
            onSelectSidechat,
          })}
        />,
      );
    });
    expect(fork).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).children.join(" ")).toContain(
      "Wait for this thread's current turn to finish",
    );

    await act(async () => {
      renderer?.update(
        <SidechatsPanel
          {...props({
            adapter: adapter(fork),
            startRequestId: 0,
            onSelectSidechat,
          })}
        />,
      );
    });
    const retry = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("New side question"));
    expect(retry?.props.disabled).not.toBe(true);
    await act(async () => retry?.props.onClick());
    expect(fork).toHaveBeenCalledTimes(1);
    expect(onSelectSidechat).toHaveBeenCalledWith("side-1");
  });

  it("keeps a failed direct fork retryable without changing the draft", async () => {
    let attempts = 0;
    const fork = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary fork failure");
      return { targetThreadId: ThreadId.make("side-retry"), origin };
    });
    const onSelectSidechat = vi.fn();
    await act(async () => {
      renderer = create(
        <SidechatsPanel
          {...props({ adapter: adapter(fork), startRequestId: 1, onSelectSidechat })}
        />,
      );
    });
    expect(renderer!.root.findByProps({ role: "alert" }).children.join(" ")).toContain(
      "temporary fork failure",
    );
    const retry = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("New side question"));
    expect(retry?.props.disabled).not.toBe(true);

    await act(async () => retry?.props.onClick());
    expect(fork).toHaveBeenCalledTimes(2);
    expect(onSelectSidechat).toHaveBeenCalledWith("side-retry");
    expect(state.addReviewComment).not.toHaveBeenCalled();
  });

  it("requires an explicit Resume action for an old sidechat", async () => {
    const onSelectSidechat = vi.fn();
    await act(async () => {
      renderer = create(<SidechatsPanel {...props({ onSelectSidechat })} />);
    });
    const resume = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Resume"));
    expect(resume).toBeDefined();
    await act(async () => resume?.props.onClick());
    expect(onSelectSidechat).toHaveBeenCalledWith(existingSidechat.id);
  });

  it("keeps the panel open when transfer is refused", async () => {
    const onClose = vi.fn();
    const view = props({
      selectedSidechatId: existingSidechat.id,
      onClose,
      resolveExcerpt: () => ({ messageId: "message-1", authorLabel: "Assistant", text: "  " }),
    });
    await act(async () => {
      renderer = create(<SidechatsPanel {...view} />);
    });
    const transfer = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Use selection & return"));
    await act(async () => transfer?.props.onClick());
    expect(state.addReviewComment).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
