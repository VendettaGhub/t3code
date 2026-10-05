export interface SessionBridgeMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

export interface SessionBridgeOrigin {
  readonly sourceThreadId: string;
  /** The global bridge records its environment alias; the single-server bridge does not. */
  readonly sourceEnvironmentId: string | null;
  readonly body: string;
  readonly sourceDisclosure?: string;
}

const MESSAGE_PREFIX = "Message from T3 thread ";
const GLOBAL_REPLY_PREFIX = ". Reply with send_message_to_thread using environmentId ";
const GLOBAL_REPLY_MIDDLE = " and threadId ";
const LOCAL_REPLY = " Reply with send_message_to_thread using that thread ID.";

/** Parses only the session bridge's persisted MCP user-message envelope for display. */
export function parseSessionBridgeMessage(
  message: SessionBridgeMessage,
): SessionBridgeOrigin | null {
  if (
    message.role !== "user" ||
    !message.id.startsWith("mcp-message:") ||
    message.id.length === "mcp-message:".length
  ) {
    return null;
  }

  const separator = /\r?\n\r?\n/.exec(message.text);
  if (separator?.index === undefined) return null;
  const header = message.text.slice(0, separator.index);
  const body = message.text.slice(separator.index + separator[0].length);
  if (!header.startsWith(MESSAGE_PREFIX)) return null;

  const afterPrefix = header.slice(MESSAGE_PREFIX.length);
  // Current global envelopes quote every caller-controlled field. Never reinterpret
  // a malformed current envelope as the older unquoted format.
  if (afterPrefix.startsWith('"')) {
    const match =
      /^("(?:[^"\\]|\\.)*") \(thread ("(?:[^"\\]|\\.)*") on environment ("(?:[^"\\]|\\.)*"); caller-declared source, existence-checked, not authenticated\)\.(.*)$/.exec(
        afterPrefix,
      );
    if (!match) return null;
    try {
      JSON.parse(match[1]!);
      const sourceThreadId: string = JSON.parse(match[2]!);
      const sourceEnvironmentId: string = JSON.parse(match[3]!);
      const reply = ` Reply with send_message_to_thread using environmentId ${JSON.stringify(sourceEnvironmentId)} and threadId ${JSON.stringify(sourceThreadId)}; include your own source environmentId and threadId.`;
      if (!sourceThreadId || !sourceEnvironmentId || (match[4] !== "" && match[4] !== reply))
        return null;
      return {
        sourceThreadId,
        sourceEnvironmentId,
        body,
        sourceDisclosure: "caller-declared source, existence-checked, not authenticated",
      };
    } catch {
      return null;
    }
  }
  const environmentMarker = " on environment ";
  const environmentIndex = afterPrefix.indexOf(environmentMarker);
  if (environmentIndex >= 0) {
    const sourceThreadId = afterPrefix.slice(0, environmentIndex);
    let sourceEnvironmentId = afterPrefix.slice(environmentIndex + environmentMarker.length);
    if (!sourceThreadId) return null;

    const replyIndex = sourceEnvironmentId.lastIndexOf(GLOBAL_REPLY_PREFIX);
    if (replyIndex >= 0) {
      const environmentFromInstruction = sourceEnvironmentId.slice(
        replyIndex + GLOBAL_REPLY_PREFIX.length,
        sourceEnvironmentId.lastIndexOf(GLOBAL_REPLY_MIDDLE),
      );
      const threadFromInstruction = sourceEnvironmentId.slice(
        sourceEnvironmentId.lastIndexOf(GLOBAL_REPLY_MIDDLE) + GLOBAL_REPLY_MIDDLE.length,
        -1,
      );
      if (
        environmentFromInstruction !== JSON.stringify(sourceEnvironmentId.slice(0, replyIndex)) ||
        threadFromInstruction !== JSON.stringify(sourceThreadId) ||
        !sourceEnvironmentId.endsWith(".")
      ) {
        return null;
      }
      sourceEnvironmentId = sourceEnvironmentId.slice(0, replyIndex);
    } else if (sourceEnvironmentId.endsWith(".")) {
      sourceEnvironmentId = sourceEnvironmentId.slice(0, -1);
    } else {
      return null;
    }
    if (!sourceEnvironmentId) return null;
    return { sourceThreadId, sourceEnvironmentId, body };
  }

  const local = afterPrefix.match(
    /^(\S+)\.(?: Reply with send_message_to_thread using that thread ID\.)?$/,
  );
  if (!local?.[1]) return null;
  const sourceThreadId = local[1];
  if (header.endsWith(LOCAL_REPLY) && !header.endsWith(`${sourceThreadId}.${LOCAL_REPLY}`)) {
    return null;
  }
  return { sourceThreadId, sourceEnvironmentId: null, body };
}

/** Resolves a bridge alias without guessing: exact environment first, then unique thread ID. */
export function resolveSessionBridgeThreadRef<
  T extends { readonly id: string; readonly environmentId: string },
>(
  origin: Pick<SessionBridgeOrigin, "sourceThreadId" | "sourceEnvironmentId">,
  currentEnvironmentId: string,
  threads: ReadonlyArray<T>,
  knownEnvironmentIds: ReadonlyArray<string>,
): T | null {
  const sourceEnvironmentId = origin.sourceEnvironmentId ?? currentEnvironmentId;
  const exact = threads.filter(
    (thread) => thread.id === origin.sourceThreadId && thread.environmentId === sourceEnvironmentId,
  );
  if (exact.length === 1) return exact[0] ?? null;
  if (
    exact.length > 1 ||
    origin.sourceEnvironmentId === null ||
    knownEnvironmentIds.includes(origin.sourceEnvironmentId)
  ) {
    return null;
  }

  const uniqueMatches = threads.filter((thread) => thread.id === origin.sourceThreadId);
  return uniqueMatches.length === 1 ? (uniqueMatches[0] ?? null) : null;
}
