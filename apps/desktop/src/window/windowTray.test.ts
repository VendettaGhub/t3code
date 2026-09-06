import * as NodeEvents from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { installWindowTray } from "./windowTray.ts";

function fixture(fail = false) {
  const app = Object.assign(new NodeEvents.EventEmitter(), {
    quit: () => {
      app.emit("before-quit");
    },
  });
  const updater = new NodeEvents.EventEmitter();
  let hidden = false;
  let minimized = true;
  let focused = false;
  let destroyed = false;
  let enabled = true;
  let readFails = false;
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
    },
    isMinimized: () => minimized,
    restore: () => {
      minimized = false;
    },
    focus: () => {
      focused = true;
    },
    isDestroyed: () => false,
    close: () => {
      destroyed = true;
    },
  });
  const tray = Object.assign(new NodeEvents.EventEmitter(), {
    destroy: () => {
      destroyed = true;
    },
  });
  let open = () => {};
  let quit = () => {};
  const install = () =>
    installWindowTray({
      app,
      updater,
      window,
      isEnabled: async () => {
        if (readFails) throw new Error("read failed");
        return enabled;
      },
      onError: () => {},
      createTray: (actions) => {
        if (fail) throw new Error("tray unavailable");
        open = actions.open;
        quit = actions.quit;
        return tray;
      },
    });
  const close = () => {
    let prevented = false;
    window.emit("close", {
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  return {
    app,
    updater,
    window,
    tray,
    install,
    close,
    open: () => open(),
    quit: () => quit(),
    disable: () => {
      enabled = false;
    },
    failRead: () => {
      readFails = true;
    },
    state: () => ({ hidden, minimized, focused, destroyed }),
  };
}

describe("Windows main-window tray", () => {
  it("falls back to normal close after a settings read error", async () => {
    const f = fixture();
    f.install();
    f.failRead();
    f.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state().destroyed).toBe(true);
  });
  it("hides on close and restores and focuses through click or menu", async () => {
    const f = fixture();
    f.install();
    expect(f.close()).toBe(true);
    await Promise.resolve();
    expect(f.state().hidden).toBe(true);
    f.tray.emit("click");
    expect(f.state()).toMatchObject({ hidden: false, minimized: false, focused: true });
    f.close();
    await Promise.resolve();
    f.open();
    expect(f.state().hidden).toBe(false);
  });
  it("reads preference changes without restart and closes normally when disabled", async () => {
    const f = fixture();
    f.install();
    f.disable();
    f.close();
    await Promise.resolve();
    expect(f.state()).toMatchObject({ hidden: false, destroyed: true });
  });
  it.each(["quit", "update", "session"])("does not intercept %s shutdown", (mode) => {
    const f = fixture();
    f.install();
    if (mode === "quit") f.quit();
    if (mode === "update") f.updater.emit("before-quit-for-update");
    if (mode === "session") f.window.emit("query-session-end");
    expect(f.close()).toBe(false);
  });
  it("disposes the tray and listeners when the main window is destroyed", () => {
    const f = fixture();
    f.install();
    f.window.emit("closed");
    expect(f.state().destroyed).toBe(true);
    expect(f.app.listenerCount("before-quit")).toBe(0);
    expect(f.updater.listenerCount("before-quit-for-update")).toBe(0);
    expect(f.close()).toBe(false);
  });
  it("does not trap the window if tray creation fails", () => {
    const f = fixture(true);
    expect(f.install).toThrow("tray unavailable");
    expect(f.close()).toBe(false);
    expect(f.app.listenerCount("before-quit")).toBe(0);
  });
});
