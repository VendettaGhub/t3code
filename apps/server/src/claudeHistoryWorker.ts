import {
  forkSession,
  getSessionMessages,
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";
import { ClaudeSessionForkError } from "./claudeSessionFork.ts";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
const uuidReference = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      mainThreadOnly: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

// The SDK import API has no source-byte limit and may allocate the whole source
// before append. This cap bounds our retained prefix/response, not the SDK's heap.
export async function readClaudeForkPrefix(
  sessionId: string,
  options: { dir: string; upToMessageId: string; targetSessionId: string; requestId: string },
) {
  const limit = 24 * 1024 * 1024;
  const entries: { entry: SessionStoreEntry; index: number }[] = [];
  let bytes = 0;
  let found = false;
  let oversizedWindow = false;
  let compacted = false;
  let projectKey: string | undefined;

  const importEntries = async (visit: (entry: SessionStoreEntry, index: number) => boolean) => {
    let index = 0;
    let stopped = false;
    await importSessionToStore(
      sessionId,
      {
        append: async (key, batch) => {
          if (stopped) return;
          if (key.sessionId !== sessionId || key.subpath !== undefined)
            throw new Error("Unexpected Claude transcript scope.");
          if (
            !/^[a-zA-Z0-9_-]+$/.test(key.projectKey) ||
            (projectKey !== undefined && projectKey !== key.projectKey)
          ) {
            throw new Error("Invalid Claude fork project key.");
          }
          projectKey = key.projectKey;
          for (const entry of batch) {
            if (visit(entry, index++)) {
              stopped = true;
              break;
            }
          }
        },
        load: async () => {
          throw new Error("Unexpected Claude transcript readback.");
        },
      },
      { dir: options.dir, includeSubagents: false },
    );
  };

  await importEntries((entry, index) => {
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      compacted = true;
      if (entry.isSidechain !== true) {
        entries.length = 0;
        bytes = 0;
        oversizedWindow = false;
      }
    }
    const attachment = entry.type === "attachment" ? entry.attachment : undefined;
    const checkpoint =
      entry.uuid === options.upToMessageId ||
      (typeof attachment === "object" &&
        attachment !== null &&
        "type" in attachment &&
        attachment.type === "queued_command" &&
        "source_uuid" in attachment &&
        attachment.source_uuid === options.upToMessageId);
    if (oversizedWindow) {
      found = checkpoint;
      return found;
    }
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + entryBytes > limit) {
      entries.length = 0;
      bytes = 0;
      oversizedWindow = true;
    } else {
      entries.push({ entry, index });
      bytes += entryBytes;
    }
    found = checkpoint;
    return found;
  });
  if (!found || projectKey === undefined) throw new Error("Claude fork checkpoint was not found.");
  if (!compacted && oversizedWindow)
    throw new ClaudeSessionForkError("Claude fork retained prefix limit exceeded.", "size-limit");

  let retained = entries;
  if (compacted) {
    // ponytail: getSessionMessages loads the full SessionStore; this O(transcript) copy needs disk-backed storage if memory becomes limiting.
    const originalPrefix: SessionStoreEntry[] = [];
    await importEntries((entry) => {
      originalPrefix.push(entry);
      const attachment = entry.type === "attachment" ? entry.attachment : undefined;
      return (
        entry.uuid === options.upToMessageId ||
        (typeof attachment === "object" &&
          attachment !== null &&
          "type" in attachment &&
          attachment.type === "queued_command" &&
          "source_uuid" in attachment &&
          attachment.source_uuid === options.upToMessageId)
      );
    });
    const projectionStore: SessionStore = {
      append: async () => {
        throw new Error("Unexpected Claude projection store write.");
      },
      load: async (key) =>
        key.subpath === undefined && key.sessionId === sessionId ? originalPrefix : null,
    };
    const projected = await getSessionMessages(sessionId, {
      dir: options.dir,
      includeSystemMessages: true,
      sessionStore: projectionStore,
    });
    const lastById = new Map<string, { entry: SessionStoreEntry; index: number }>();
    originalPrefix.forEach((entry, index) => {
      if (typeof entry.uuid === "string") lastById.set(entry.uuid, { entry, index });
    });
    const physicalIds = new Set(lastById.keys());
    originalPrefix.forEach((entry, index) => {
      const attachment = entry.type === "attachment" ? entry.attachment : undefined;
      if (
        typeof attachment === "object" &&
        attachment !== null &&
        "type" in attachment &&
        attachment.type === "queued_command" &&
        "source_uuid" in attachment &&
        typeof attachment.source_uuid === "string" &&
        !physicalIds.has(attachment.source_uuid)
      ) {
        lastById.set(attachment.source_uuid, { entry, index });
      }
    });
    const selected = projected.map((message) => {
      const source = lastById.get(message.uuid);
      if (!source) throw new ClaudeSessionForkError("Unsupported projected Claude history entry.");
      return { ...source, projectedId: message.uuid };
    });
    if (selected.at(-1)?.entry.uuid !== options.upToMessageId)
      throw new ClaudeSessionForkError("Missing projected assistant checkpoint.");

    const retainedIds = new Set(
      selected.flatMap(({ entry, projectedId }) => [entry.uuid, projectedId]),
    );
    const requiredIds = new Set<string>();
    const addReference = (value: unknown) => {
      if (typeof value === "string" && uuidReference.test(value)) requiredIds.add(value);
    };
    for (const { entry } of selected) {
      const compact = entry.compactMetadata as Record<string, unknown> | undefined;
      const preserved = compact?.preservedMessages as Record<string, unknown> | undefined;
      addReference(preserved?.anchorUuid);
      if (Array.isArray(preserved?.uuids)) preserved.uuids.forEach(addReference);
      const segment = compact?.preservedSegment as Record<string, unknown> | undefined;
      addReference(segment?.headUuid);
      addReference(segment?.anchorUuid);
      addReference(segment?.tailUuid);
      if (typeof segment?.tailUuid === "string" && typeof segment.headUuid === "string") {
        let current: string | undefined = segment.tailUuid;
        const visited = new Set<string>();
        while (current !== undefined && current !== segment.headUuid && !visited.has(current)) {
          visited.add(current);
          requiredIds.add(current);
          const source = lastById.get(current);
          current =
            typeof source?.entry.parentUuid === "string" ? source.entry.parentUuid : undefined;
        }
      }
    }
    const supplemental = [...requiredIds]
      .filter((id) => !retainedIds.has(id))
      .flatMap((id) => {
        const source = lastById.get(id);
        return source === undefined ? [] : [source];
      })
      .sort((left, right) => left.index - right.index);
    let retainedBytes = 0;
    const normalizedSelected = selected.map(({ entry, index }, position) => {
      const normalized = { ...entry } as unknown as Record<string, unknown>;
      normalized.parentUuid = position === 0 ? null : selected[position - 1]!.entry.uuid;
      for (const key of ["logicalParentUuid", "sourceToolAssistantUUID"]) {
        const value = normalized[key];
        if (typeof value === "string" && uuidReference.test(value) && !retainedIds.has(value))
          normalized[key] = null;
      }
      return { entry: normalized as unknown as SessionStoreEntry, index };
    });
    const checkpoint = normalizedSelected.pop()!;
    retained = [...normalizedSelected, ...supplemental, checkpoint];
    for (const { entry } of retained) {
      retainedBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
      if (retainedBytes > limit)
        throw new ClaudeSessionForkError(
          "Claude fork retained prefix limit exceeded.",
          "size-limit",
        );
    }
  }
  return {
    sourceSessionId: sessionId,
    targetSessionId: options.targetSessionId,
    requestId: options.requestId,
    checkpointId: options.upToMessageId,
    projectKey,
    compacted,
    entries: retained.map(({ entry }) => entry),
  };
}

export async function hasClaudeSessionCompaction(
  sessionId: string,
  // mainThreadOnly ignores sidechain rows inside the main transcript; only a
  // main-thread boundary proves the main history was compacted.
  options: { dir?: string; upToMessageId?: string; mainThreadOnly?: boolean },
): Promise<boolean> {
  let compacted = false;
  let foundCheckpoint = false;
  await importSessionToStore(
    sessionId,
    {
      append: async (key, entries) => {
        if (key.sessionId !== sessionId || key.subpath !== undefined) {
          throw new Error("Unexpected Claude transcript scope.");
        }
        for (const entry of entries) {
          if (foundCheckpoint) break;
          if (
            entry.type === "system" &&
            entry.subtype === "compact_boundary" &&
            !(options.mainThreadOnly && entry.isSidechain === true)
          ) {
            compacted = true;
          }
          if (entry.uuid === options.upToMessageId) foundCheckpoint = true;
        }
      },
      load: async () => {
        throw new Error("Unexpected Claude transcript readback.");
      },
    },
    { ...(options.dir === undefined ? {} : { dir: options.dir }), includeSubagents: false },
  );
  if (!foundCheckpoint) throw new Error("Claude checkpoint was not found in the raw transcript.");
  return compacted;
}

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  if (!sessionId) throw new Error("Claude history session id is required.");
  if (method === "readForkPrefix") {
    if (!process.env.CLAUDE_CONFIG_DIR)
      throw new Error("Explicit Claude provider home is required.");
    const request = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          dir: Schema.String,
          upToMessageId: Schema.optionalKey(Schema.String),
          targetSessionId: Schema.String,
          requestId: Schema.String,
        }),
      ),
    )(rawOptions ?? "{}");
    try {
      const checkpoint =
        request.upToMessageId === undefined
          ? (await getSessionMessages(sessionId, { dir: request.dir })).at(-1)
          : undefined;
      const upToMessageId =
        request.upToMessageId ?? (checkpoint?.type === "assistant" ? checkpoint.uuid : undefined);
      if (upToMessageId === undefined)
        throw new ClaudeSessionForkError("Missing projected assistant checkpoint.");
      const result = await readClaudeForkPrefix(sessionId, { ...request, upToMessageId });
      // Entry JSON was counted before retention (24 MiB), leaving envelope headroom.
      const output = JSON.stringify(result);
      if (Buffer.byteLength(output, "utf8") > 32 * 1024 * 1024)
        throw new ClaudeSessionForkError("Claude fork output limit exceeded.", "size-limit");
      process.stdout.write(output);
    } catch (error) {
      if (!(error instanceof ClaudeSessionForkError)) throw error;
      // A complete protocol response, not a successful fork. Never send diagnostics.
      process.stdout.write(
        JSON.stringify({
          sourceSessionId: sessionId,
          targetSessionId: request.targetSessionId,
          checkpointId: request.upToMessageId,
          requestId: request.requestId,
          forkFailureReason: error.forkFailureReason,
        }),
      );
    }
    return;
  }
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  const result =
    method === "getSessionMessages"
      ? (await getSessionMessages(sessionId, options)).map((entry) =>
          // SDK system markers may have no message; JSON would otherwise omit
          // the key required by the history wire shape. Conversation bodies stay exact.
          entry.type === "system" && entry.message === undefined
            ? { ...entry, message: null }
            : entry,
        )
      : method === "forkSession"
        ? await forkSession(sessionId, options)
        : method === "hasSessionCompaction"
          ? await hasClaudeSessionCompaction(sessionId, options)
          : (() => {
              throw new Error("Unknown Claude history operation.");
            })();
  process.stdout.write(JSON.stringify(result));
}
