import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindowsTray from "../electron/ElectronWindowsTray.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopWindowsTray from "./DesktopWindowsTray.ts";

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "win32",
  processArch: "x64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_PORT: "3773" })),
  ),
);

const makeTestLayer = Effect.fn("makeDesktopWindowsTrayTestLayer")(function* (input?: {
  readonly activate?: Effect.Effect<void, DesktopWindow.DesktopWindowError>;
  readonly createError?: ElectronWindowsTray.ElectronWindowsTrayError;
  readonly windowsTrayEnabled?: boolean;
}) {
  const activationCount = yield* Ref.make(0);
  const quitCount = yield* Ref.make(0);
  const destroyCount = yield* Ref.make(0);
  const backendReady = yield* Ref.make(false);
  const quitting = yield* Ref.make(false);
  const windowsTrayReady = yield* Ref.make(false);
  let createInput: ElectronWindowsTray.ElectronWindowsTrayCreateInput | undefined;

  const stateLayer = Layer.succeed(DesktopState.DesktopState, {
    backendReady,
    quitting,
    windowsTrayReady,
  });
  const trayLayer = Layer.succeed(ElectronWindowsTray.ElectronWindowsTray, {
    create: (value) => {
      createInput = value;
      return input?.createError ? Effect.fail(input.createError) : Effect.void;
    },
    destroy: Ref.update(destroyCount, (count) => count + 1),
  });
  const layer = DesktopWindowsTray.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        environmentLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.some("C:\\icons\\t3.ico"),
            icns: Option.none<string>(),
            png: Option.none<string>(),
          }),
          resolveResourcePath: () => Effect.succeed(Option.none()),
        } satisfies DesktopAssets.DesktopAssets["Service"]),
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          windowsTrayEnabled: input?.windowsTrayEnabled ?? true,
        }),
        stateLayer,
        trayLayer,
        Layer.mock(ElectronApp.ElectronApp)({
          name: Effect.succeed("T3 Code"),
          quit: Ref.update(quitCount, (count) => count + 1),
        }),
        Layer.mock(DesktopWindow.DesktopWindow)({
          activate: Ref.update(activationCount, (count) => count + 1).pipe(
            Effect.andThen(input?.activate ?? Effect.void),
          ),
        }),
      ),
    ),
  );

  return {
    activationCount,
    quitCount,
    destroyCount,
    windowsTrayReady,
    getCreateInput: () => createInput,
    layer,
  };
});

describe("DesktopWindowsTray", () => {
  it.effect("configures Open, double-click, Quit, readiness, and cleanup", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
          yield* tray.configure;

          const input = test.getCreateInput();
          assert.isDefined(input);
          assert.equal(input?.iconPath, "C:\\icons\\t3.ico");
          assert.equal(input?.tooltip, "T3 Code");
          assert.equal(input?.menu[0]?.label, "Open T3 Code");
          assert.equal(input?.menu[2]?.label, "Quit T3 Code");
          input?.menu[0]?.click?.({} as never, {} as never, {} as never);
          input?.onDoubleClick();
          input?.menu[2]?.click?.({} as never, {} as never, {} as never);
          yield* Effect.promise(() => Promise.resolve());

          assert.equal(yield* Ref.get(test.activationCount), 2);
          assert.equal(yield* Ref.get(test.quitCount), 1);
          assert.isTrue(yield* Ref.get(test.windowsTrayReady));
        }).pipe(Effect.provide(test.layer)),
      );

      assert.equal(yield* Ref.get(test.destroyCount), 1);
      assert.isFalse(yield* Ref.get(test.windowsTrayReady));
    }),
  );

  it.effect("keeps close-to-tray disabled when native tray creation fails", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer({
        createError: new ElectronWindowsTray.ElectronWindowsTrayError({
          operation: "create",
          platform: "win32",
          cause: new Error("tray unavailable"),
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* tray.configure;
          assert.equal((yield* settings.get).windowsTrayEnabled, false);
          assert.isFalse(yield* Ref.get(test.windowsTrayReady));
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("reveals the window before disabling and destroying the Windows tray", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* tray.configure;

          const result = yield* tray.setEnabled(false);

          assert.equal(result.enabled, false);
          assert.equal((yield* settings.get).windowsTrayEnabled, false);
          assert.equal(yield* Ref.get(test.activationCount), 1);
          assert.equal(yield* Ref.get(test.destroyCount), 1);
          assert.isFalse(yield* Ref.get(test.windowsTrayReady));
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("disables close-to-tray before waiting for the window to reveal", () =>
    Effect.gen(function* () {
      const activationStarted = yield* Deferred.make<void>();
      const releaseActivation = yield* Deferred.make<void>();
      const test = yield* makeTestLayer({
        activate: Deferred.succeed(activationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseActivation)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
          yield* tray.configure;
          const disableFiber = yield* Effect.forkChild(tray.setEnabled(false));
          yield* Deferred.await(activationStarted);

          assert.isFalse(yield* Ref.get(test.windowsTrayReady));

          yield* Deferred.succeed(releaseActivation, undefined);
          yield* Fiber.join(disableFiber);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("restores close-to-tray when revealing the window fails during disable", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer({
        activate: Effect.die("reveal failed"),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* tray.configure;
          const exit = yield* Effect.exit(tray.setEnabled(false));

          assert.isTrue(exit._tag === "Failure");
          assert.equal((yield* settings.get).windowsTrayEnabled, true);
          assert.isTrue(yield* Ref.get(test.windowsTrayReady));
          assert.equal(yield* Ref.get(test.destroyCount), 0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("does not persist enabled when native tray creation fails", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer({
        createError: new ElectronWindowsTray.ElectronWindowsTrayError({
          operation: "create",
          platform: "win32",
          cause: new Error("tray unavailable"),
        }),
        windowsTrayEnabled: false,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          const result = yield* tray.setEnabled(true);

          assert.equal(result.enabled, false);
          assert.equal((yield* settings.get).windowsTrayEnabled, false);
          assert.isFalse(yield* Ref.get(test.windowsTrayReady));
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );
});
