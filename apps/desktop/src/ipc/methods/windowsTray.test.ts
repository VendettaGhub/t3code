import { DesktopWindowsTrayStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindowsTray from "../../window/DesktopWindowsTray.ts";
import { getWindowsTrayState, setWindowsTrayEnabled } from "./windowsTray.ts";

const decodeState = Schema.decodeUnknownEffect(DesktopWindowsTrayStateSchema);

describe("Windows tray IPC", () => {
  it.effect("reads and updates the tray preference through the tray service", () => {
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest(),
      Layer.succeed(
        DesktopWindowsTray.DesktopWindowsTray,
        DesktopWindowsTray.DesktopWindowsTray.of({
          configure: Effect.void,
          setEnabled: (enabled) => Effect.succeed({ enabled }),
        }),
      ),
    );

    return Effect.gen(function* () {
      assert.deepEqual(
        yield* getWindowsTrayState.handler(undefined).pipe(Effect.flatMap(decodeState)),
        { enabled: false },
      );
      assert.deepEqual(
        yield* setWindowsTrayEnabled.handler(true).pipe(Effect.flatMap(decodeState)),
        { enabled: true },
      );
    }).pipe(Effect.provide(layer));
  });
});
