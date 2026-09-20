import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatView from "./ChatView";

/**
 * Reuses the normal timeline, composer and provider tools for a forked thread.
 * ChatView's embedded mode suppresses document-level shortcuts and hides the
 * workspace header/panel chrome, so this does not create a second global chat
 * surface while it is mounted in the sidechat panel.
 */
export function SidechatThreadHost({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&_[data-chat-header]]:hidden"
      data-sidechat-thread-host="true"
    >
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        embedded
        reserveTitleBarControlInset={false}
      />
    </div>
  );
}
