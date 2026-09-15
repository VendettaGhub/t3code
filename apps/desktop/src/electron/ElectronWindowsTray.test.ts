import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { buildFromTemplateMock, trayBehavior, trayInstances, TrayMock } = vi.hoisted(() => {
  const trayBehavior = { setToolTipError: null as Error | null };

  class FakeTray {
    readonly listeners = new Map<string, () => void>();
    readonly icon: string;
    contextMenu: unknown = null;
    destroyed = false;
    tooltip: string | null = null;

    constructor(icon: string) {
      this.icon = icon;
      trayInstances.push(this);
    }

    destroy() {
      this.destroyed = true;
    }

    isDestroyed() {
      return this.destroyed;
    }

    on(eventName: string, listener: () => void) {
      this.listeners.set(eventName, listener);
      return this;
    }

    setContextMenu(menu: unknown) {
      this.contextMenu = menu;
    }

    setToolTip(tooltip: string) {
      if (trayBehavior.setToolTipError !== null) throw trayBehavior.setToolTipError;
      this.tooltip = tooltip;
    }
  }

  const trayInstances: FakeTray[] = [];
  return {
    buildFromTemplateMock: vi.fn((template: unknown) => ({ template })),
    trayBehavior,
    trayInstances,
    TrayMock: FakeTray,
  };
});

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: buildFromTemplateMock },
  Tray: TrayMock,
}));

import * as ElectronWindowsTray from "./ElectronWindowsTray.ts";

const TestLayer = ElectronWindowsTray.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
);

describe("ElectronWindowsTray", () => {
  it.effect("creates and destroys a native tray with menu and double-click behavior", () =>
    Effect.gen(function* () {
      trayInstances.length = 0;
      trayBehavior.setToolTipError = null;
      buildFromTemplateMock.mockClear();
      const tray = yield* ElectronWindowsTray.ElectronWindowsTray;
      const onDoubleClick = vi.fn();
      const menu = [{ label: "Open" }];

      yield* tray.create({
        iconPath: "C:\\icons\\t3.ico",
        tooltip: "T3 Code",
        menu,
        onDoubleClick,
      });

      const nativeTray = trayInstances[0];
      assert.isDefined(nativeTray);
      assert.equal(nativeTray?.icon, "C:\\icons\\t3.ico");
      assert.equal(nativeTray?.tooltip, "T3 Code");
      assert.deepEqual(buildFromTemplateMock.mock.calls[0]?.[0], menu);
      nativeTray?.listeners.get("double-click")?.();
      assert.equal(onDoubleClick.mock.calls.length, 1);

      yield* tray.destroy;
      assert.isTrue(nativeTray?.destroyed ?? false);
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("destroys a partially initialized native tray when setup fails", () =>
    Effect.gen(function* () {
      trayInstances.length = 0;
      trayBehavior.setToolTipError = new Error("tooltip failed");
      const tray = yield* ElectronWindowsTray.ElectronWindowsTray;

      const exit = yield* Effect.exit(
        tray.create({
          iconPath: "C:\\icons\\t3.ico",
          tooltip: "T3 Code",
          menu: [{ label: "Open" }],
          onDoubleClick: vi.fn(),
        }),
      );

      assert.isTrue(exit._tag === "Failure");
      assert.isTrue(trayInstances[0]?.destroyed ?? false);
      trayBehavior.setToolTipError = null;
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );
});
