import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindowsTray from "../electron/ElectronWindowsTray.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopWindowsTray extends Context.Service<
  DesktopWindowsTray,
  {
    readonly configure: Effect.Effect<void>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<
      { readonly enabled: boolean },
      DesktopAppSettings.DesktopSettingsWriteError | DesktopWindow.DesktopWindowError
    >;
  }
>()("@t3tools/desktop/window/DesktopWindowsTray") {}

type DesktopWindowsTrayRuntimeServices =
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp;

const { logError, logWarning } = makeComponentLogger("desktop-windows-tray");

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTray = yield* ElectronWindowsTray.ElectronWindowsTray;
  const appName = yield* electronApp.name;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<DesktopWindowsTrayRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const transitionMutex = yield* Semaphore.make(1);

  const runAction = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopWindowsTrayRuntimeServices>,
  ) => {
    runFork(
      effect.pipe(
        Effect.catchCause((cause) => logError(`tray action ${action} failed`, { cause })),
      ),
    );
  };

  const destroy = electronTray.destroy.pipe(
    Effect.catchCause((cause) => logError("could not destroy the Windows tray", { cause })),
    Effect.andThen(Ref.set(state.windowsTrayReady, false)),
  );

  yield* Effect.addFinalizer(() => destroy);

  const createNative = Effect.gen(function* () {
    const iconPaths = yield* assets.iconPaths;
    if (Option.isNone(iconPaths.ico)) {
      yield* logWarning("Windows tray icon is missing");
      return false;
    }
    return yield* electronTray
      .create({
        iconPath: iconPaths.ico.value,
        tooltip: appName,
        menu: [
          {
            label: `Open ${appName}`,
            click: () => runAction("open", desktopWindow.activate),
          },
          { type: "separator" },
          {
            label: `Quit ${appName}`,
            click: () => runAction("quit", electronApp.quit),
          },
        ],
        onDoubleClick: () => runAction("open", desktopWindow.activate),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logError("could not create the Windows tray", { cause }).pipe(Effect.as(false)),
        ),
      );
  });

  const configure = transitionMutex.withPermit(
    Effect.gen(function* () {
      if (environment.platform !== "win32" || !(yield* settings.get).windowsTrayEnabled) {
        return;
      }
      if (yield* createNative) {
        yield* Ref.set(state.windowsTrayReady, true);
        return;
      }
      yield* settings
        .setWindowsTrayEnabled(false)
        .pipe(
          Effect.catchCause((cause) =>
            logError("could not reset the Windows tray setting", { cause }),
          ),
        );
    }),
  );

  const setEnabled = Effect.fn("desktop.windowsTray.setEnabled")(function* (enabled: boolean) {
    return yield* transitionMutex.withPermit(
      Effect.gen(function* () {
        if (!enabled) {
          const wasReady = yield* Ref.get(state.windowsTrayReady);
          yield* Ref.set(state.windowsTrayReady, false);
          return yield* Effect.gen(function* () {
            yield* desktopWindow.activate;
            const change = yield* settings.setWindowsTrayEnabled(false);
            yield* destroy;
            return { enabled: change.settings.windowsTrayEnabled };
          }).pipe(Effect.onError(() => Ref.set(state.windowsTrayReady, wasReady)));
        }

        if (!(yield* createNative)) {
          return { enabled: false };
        }
        const change = yield* settings
          .setWindowsTrayEnabled(true)
          .pipe(Effect.onError(() => destroy));
        yield* Ref.set(state.windowsTrayReady, true);
        return { enabled: change.settings.windowsTrayEnabled };
      }),
    );
  });

  return DesktopWindowsTray.of({ configure, setEnabled });
});

export const layer = Layer.effect(DesktopWindowsTray, make);
