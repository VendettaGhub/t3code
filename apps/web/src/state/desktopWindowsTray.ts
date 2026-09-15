import type { DesktopBridge, DesktopWindowsTrayState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type DesktopWindowsTrayBridge = Pick<DesktopBridge, "getWindowsTrayState">;

class DesktopWindowsTrayStateUnavailableError extends Schema.TaggedErrorClass<DesktopWindowsTrayStateUnavailableError>()(
  "DesktopWindowsTrayStateUnavailableError",
  {},
) {}

class DesktopWindowsTrayStateLoadError extends Schema.TaggedErrorClass<DesktopWindowsTrayStateLoadError>()(
  "DesktopWindowsTrayStateLoadError",
  { cause: Schema.Defect() },
) {}

function getDesktopWindowsTrayBridge(): DesktopWindowsTrayBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopWindowsTrayStateAtom(
  getBridge: () => DesktopWindowsTrayBridge | undefined,
) {
  const load = Effect.fn("loadDesktopWindowsTrayState")(function* () {
    const bridge = getBridge();
    if (!bridge) {
      return yield* new DesktopWindowsTrayStateUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopWindowsTrayState> => bridge.getWindowsTrayState(),
      catch: (cause) => new DesktopWindowsTrayStateLoadError({ cause }),
    });
  });

  return Atom.make(load()).pipe(
    Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
    Atom.keepAlive,
    Atom.withLabel("desktop:windows-tray-state:load"),
  );
}

export const desktopWindowsTrayStateAtom = createDesktopWindowsTrayStateAtom(
  getDesktopWindowsTrayBridge,
);

export function refreshDesktopWindowsTrayState(): void {
  appAtomRegistry.refresh(desktopWindowsTrayStateAtom);
}
