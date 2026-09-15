import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export interface ElectronWindowsTrayCreateInput {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly menu: readonly Electron.MenuItemConstructorOptions[];
  readonly onDoubleClick: () => void;
}

export class ElectronWindowsTrayError extends Schema.TaggedErrorClass<ElectronWindowsTrayError>()(
  "ElectronWindowsTrayError",
  {
    operation: Schema.Literals(["create", "destroy"]),
    platform: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ElectronWindowsTray extends Context.Service<
  ElectronWindowsTray,
  {
    readonly create: (
      input: ElectronWindowsTrayCreateInput,
    ) => Effect.Effect<void, ElectronWindowsTrayError>;
    readonly destroy: Effect.Effect<void, ElectronWindowsTrayError>;
  }
>()("@t3tools/desktop/electron/ElectronWindowsTray") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  let tray: Electron.Tray | null = null;

  return ElectronWindowsTray.of({
    create: (input) =>
      Effect.try({
        try: () => {
          if (tray !== null && !tray.isDestroyed()) return;
          tray = new Electron.Tray(input.iconPath);
          tray.setToolTip(input.tooltip);
          tray.setContextMenu(Electron.Menu.buildFromTemplate([...input.menu]));
          tray.on("double-click", input.onDoubleClick);
        },
        catch: (cause) => {
          let reportedCause = cause;
          try {
            if (tray !== null && !tray.isDestroyed()) tray.destroy();
          } catch (cleanupCause) {
            reportedCause = new AggregateError(
              [cause, cleanupCause],
              "Tray initialization and cleanup failed",
            );
          }
          tray = null;
          return new ElectronWindowsTrayError({
            operation: "create",
            platform,
            cause: reportedCause,
          });
        },
      }),
    destroy: Effect.try({
      try: () => {
        if (tray !== null && !tray.isDestroyed()) tray.destroy();
        tray = null;
      },
      catch: (cause) => new ElectronWindowsTrayError({ operation: "destroy", platform, cause }),
    }),
  });
});

export const layer = Layer.effect(ElectronWindowsTray, make);
