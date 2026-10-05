import { act, useLayoutEffect } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ComposerHandleContext,
  useComposerHandleContext,
  type ComposerHandleRef,
} from "../composerHandleContext";
import { SidechatThreadHost } from "./SidechatThreadHost";

vi.mock("./ChatView", () => ({
  default: function EmbeddedComposer() {
    const ref = useComposerHandleContext();
    useLayoutEffect(() => {
      if (!ref) throw new Error("Missing isolated composer scope");
      ref.current = { focus: vi.fn() } as unknown as NonNullable<ComposerHandleRef["current"]>;
      return () => {
        ref.current = null;
      };
    }, [ref]);
    return null;
  },
}));

it("mounting and closing a sidechat cannot replace or clear the main composer handle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mainHandle = { focus: vi.fn() } as unknown as NonNullable<ComposerHandleRef["current"]>;
  const mainRef: ComposerHandleRef = { current: mainHandle };
  const renderer = await act(() =>
    create(
      <ComposerHandleContext value={mainRef}>
        <SidechatThreadHost
          threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("child") }}
        />
      </ComposerHandleContext>,
    ),
  );
  try {
    expect(mainRef.current).toBe(mainHandle);
  } finally {
    await act(() => renderer.unmount());
    vi.unstubAllGlobals();
  }
  expect(mainRef.current).toBe(mainHandle);
});
