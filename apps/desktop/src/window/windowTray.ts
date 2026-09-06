import type * as NodeEvents from "node:events";

type Events = Pick<NodeEvents.EventEmitter, "on" | "removeListener">;

/** Install only on the main Windows window, after a usable tray icon exists. */
export function installWindowTray(input: {
  app: Events & { quit(): void };
  updater: Events;
  window: Events & {
    hide(): void;
    show(): void;
    restore(): void;
    focus(): void;
    close(): void;
    isMinimized(): boolean;
    isDestroyed(): boolean;
  };
  isEnabled(): Promise<boolean>;
  onError(error: unknown): void;
  createTray(actions: { open(): void; quit(): void }): Events & { destroy(): void };
}) {
  const { app, updater, window } = input;
  let quitting = false;
  let closing = false;
  let disposed = false;
  const open = () => {
    if (disposed || quitting || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const markQuitting = () => {
    quitting = true;
  };
  const tray = input.createTray({
    open,
    quit: () => {
      markQuitting();
      app.quit();
    },
  });
  const close = (event: { preventDefault(): void }) => {
    if (quitting || disposed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void input
      .isEnabled()
      .then((enabled) => {
        if (disposed || quitting || window.isDestroyed()) return;
        if (enabled) window.hide();
        else {
          // Re-enter the normal close path once, including bounds persistence.
          quitting = true;
          window.close();
        }
      })
      .catch((error) => {
        input.onError(error);
        if (disposed || quitting || window.isDestroyed()) return;
        quitting = true;
        window.close();
      })
      .finally(() => {
        closing = false;
      });
  };
  const dispose = () => {
    disposed = true;
    window.removeListener("close", close);
    window.removeListener("closed", dispose);
    window.removeListener("query-session-end", markQuitting);
    app.removeListener("before-quit", markQuitting);
    updater.removeListener("before-quit-for-update", markQuitting);
    tray.removeListener("click", open);
    tray.destroy();
  };
  app.on("before-quit", markQuitting);
  updater.on("before-quit-for-update", markQuitting);
  window.on("query-session-end", markQuitting);
  window.on("close", close);
  window.on("closed", dispose);
  tray.on("click", open);
  return dispose;
}
