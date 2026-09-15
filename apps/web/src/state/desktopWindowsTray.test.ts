import type { DesktopWindowsTrayState } from "@t3tools/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopWindowsTrayStateAtom } from "./desktopWindowsTray";

describe("desktopWindowsTray", () => {
  it("replaces cached state with refreshed live desktop state", async () => {
    let currentState: DesktopWindowsTrayState = { enabled: false };
    const getWindowsTrayState = vi.fn(async () => currentState);
    const atom = createDesktopWindowsTrayStateAtom(() => ({ getWindowsTrayState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: { enabled: false } }),
      );
    });

    currentState = { enabled: true };
    registry.refresh(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: { enabled: true } }),
      );
    });
    expect(getWindowsTrayState).toHaveBeenCalledTimes(2);
    registry.dispose();
  });
});
