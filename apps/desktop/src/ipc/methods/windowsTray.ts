import { DesktopWindowsTrayStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindowsTray from "../../window/DesktopWindowsTray.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getWindowsTrayState = makeIpcMethod({
  channel: IpcChannels.GET_WINDOWS_TRAY_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowsTrayStateSchema,
  handler: Effect.fn("desktop.ipc.windowsTray.getState")(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return { enabled: (yield* settings.get).windowsTrayEnabled };
  }),
});

export const setWindowsTrayEnabled = makeIpcMethod({
  channel: IpcChannels.SET_WINDOWS_TRAY_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopWindowsTrayStateSchema,
  handler: Effect.fn("desktop.ipc.windowsTray.setEnabled")(function* (enabled) {
    const tray = yield* DesktopWindowsTray.DesktopWindowsTray;
    return yield* tray.setEnabled(enabled);
  }),
});
