import {
  getSessionMessages,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
const { randomUUID } = NodeCrypto;
const { isDeepStrictEqual } = NodeUtil;

// SDK 0.3.276 / CLI 2.1.283: this is a private transcript format, not arbitrary JSON.
// Unknown structural metadata must fail closed until its semantics are verified.
export class ClaudeSessionForkError extends Error {
  readonly _tag = "ClaudeSessionForkError";
  readonly forkFailureReason: "unsupported-format" | "size-limit";
  constructor(
    message: string,
    forkFailureReason: "unsupported-format" | "size-limit" = "unsupported-format",
  ) {
    super(message);
    this.forkFailureReason = forkFailureReason;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const transcriptTypes = new Set(["user", "assistant", "system", "attachment", "progress"]);
const ignoredTypes = new Set([
  "queue-operation",
  "last-prompt",
  "ai-title",
  "custom-title",
  "tag",
  "cost-state",
  "mode",
]);
const commonFields = new Set([
  "type",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "sessionId",
  "timestamp",
  "cwd",
  "version",
  "gitBranch",
  "entrypoint",
  "userType",
  "isSidechain",
  "teamName",
  "agentName",
  "sessionKind",
  "slug",
  "forkedFrom",
]);
const entryFields: Record<string, ReadonlySet<string>> = {
  user: new Set([
    "message",
    "sourceToolAssistantUUID",
    "sourceToolUseID",
    "imagePasteIds",
    "interruptedByShutdown",
    "isCompactSummary",
    "isMeta",
    "isVisibleInTranscriptOnly",
    "mcpMeta",
    "origin",
    "permissionMode",
    "promptId",
    "promptSource",
    "queueSkipAttachments",
    "queueTranscriptOnly",
    "toolDenialKind",
    "toolUseResult",
    "turnCompanion",
    "turnOrigin",
  ]),
  assistant: new Set([
    "message",
    "apiBlockIndex",
    "attributionPlugin",
    "attributionMcpServer",
    "attributionMcpTool",
    "attributionSkill",
    "effort",
    "thinkingDurationMs",
    "isApiErrorMessage",
    "perTurnEffort",
    "requestId",
    "wireIngestContext",
    "wireToolInputs",
    "sourceToolAssistantUUID",
  ]),
  system: new Set([
    "subtype",
    "content",
    "compactMetadata",
    "logicalParentUuid",
    "hasOutput",
    "hookAdditionalContext",
    "hookCount",
    "hookErrors",
    "hookInfos",
    "isMeta",
    "level",
    "preventedContinuation",
    "stopReason",
    "toolUseID",
    "neutralizedByFork",
  ]),
  attachment: new Set(["attachment", "rendered", "renderedInHumanTurn", "renderedRole"]),
  progress: new Set(["data", "toolUseID", "parentToolUseID"]),
};
// These attachment payloads are opaque; only queued/deferred fields below name local IDs.
const attachmentFields: Record<string, string> = {
  hook_success: "command content durationMs exitCode hookEvent hookName stderr stdout toolUseID",
  hook_additional_context: "content hookEvent hookName toolUseID",
  hook_non_blocking_error: "command durationMs exitCode hookEvent hookName stderr stdout toolUseID",
  hook_system_message: "content hookEvent hookName toolUseID",
  environment: "changes snapshot",
  model: "identity text",
  output_style_instructions: "style",
  agent_listing_delta:
    "addedLines addedTypes builtInTypes isInitial removedTypes showConcurrencyNote",
  mcp_instructions_delta: "addedBlocks addedNames removedNames",
  skill_listing: "content isInitial names skillCount",
  auto_mode: "autoModeConsentFlow bashFirst bashFirstSteer bypass steerOnly",
  output_style: "style turnReminder",
  instructions: "changed files reason",
  session_context: "context",
  date: "changed date",
  prompt_snapshot:
    "cliPrefix contextRendering echoWireToolInputs inlineTools keptReminders reminderFold systemPrompt systemTurns toolChangeHeader tools",
  silent_turn_reminder: "text",
  queued_command:
    "commandMode delivery_id isMeta origin prompt source_uuid timestamp usage forwardedIntent",
  credential_org: "organizationUuid",
  deferred_tools_record: "entries toolInputCopies nameOnlyAnnouncements",
  edited_text_file: "filename snippet",
  file: "content displayPath filename",
  task_status: "deltaSummary description outputFilePath shell status taskId taskType",
  command_permissions: "allowedTools",
  compact_file_reference: "displayPath filename",
  invoked_skills: "skills",
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaudeSessionForkError("Unsupported Claude history metadata object.");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ClaudeSessionForkError("Invalid Claude history reference.");
  }
  return value;
}

function uuidList(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new ClaudeSessionForkError("Invalid Claude history reference list.");
  return value.map(uuid);
}

function knownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new ClaudeSessionForkError("Unsupported Claude compaction metadata field.");
  }
}

function queuedId(entry: SessionStoreEntry): string | undefined {
  if (entry.type !== "attachment") return undefined;
  const attachment = object(entry.attachment);
  return attachment.type === "queued_command" && attachment.source_uuid !== undefined
    ? uuid(attachment.source_uuid)
    : undefined;
}

export function encodeClaudeForkJsonl(entries: ReadonlyArray<SessionStoreEntry>): Buffer {
  const lines: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const line = `${JSON.stringify(entry)}\n`;
    bytes += Buffer.byteLength(line, "utf8");
    if (bytes > 32 * 1024 * 1024)
      throw new ClaudeSessionForkError("Claude fork output limit exceeded.", "size-limit");
    lines.push(line);
  }
  return Buffer.from(lines.join(""), "utf8");
}

export async function prepareClaudeSessionPrefix(
  entries: ReadonlyArray<SessionStoreEntry>,
  sourceSessionId: string,
  checkpointId: string,
  targetSessionId: string,
) {
  const remapped = remapClaudeSessionPrefix(
    entries,
    sourceSessionId,
    checkpointId,
    targetSessionId,
  );
  const end = entries.findIndex((entry) => entry.uuid === checkpointId);
  if (end < 0 || entries[end]?.type !== "assistant")
    throw new ClaudeSessionForkError("Missing projected assistant checkpoint.");
  const prefix = entries.slice(0, end + 1);
  const sessionStore: SessionStore = {
    append: async () => {
      throw new ClaudeSessionForkError("Unexpected verification store write.");
    },
    load: async (key) =>
      key.subpath !== undefined
        ? null
        : key.sessionId === sourceSessionId
          ? [...prefix]
          : key.sessionId === targetSessionId
            ? remapped.entries
            : null,
  };
  // Explicit in-memory store: this projection must never consult a native home.
  const before = await getSessionMessages(sourceSessionId, { dir: "/", sessionStore });
  const after = await getSessionMessages(targetSessionId, { dir: "/", sessionStore });
  if (before.at(-1)?.uuid !== checkpointId || before.at(-1)?.type !== "assistant") {
    throw new ClaudeSessionForkError("Missing projected assistant checkpoint.");
  }
  if (
    before.length !== after.length ||
    before.some((message, index) => {
      const copy = after[index];
      return (
        copy === undefined ||
        copy.type !== message.type ||
        !isDeepStrictEqual(copy.message, message.message) ||
        copy.uuid !== remapped.ids.get(message.uuid)
      );
    })
  )
    throw new ClaudeSessionForkError("Claude fork did not preserve exact conversation history.");
  return remapped;
}

export function remapClaudeSessionPrefix(
  entries: ReadonlyArray<SessionStoreEntry>,
  sourceSessionId: string,
  checkpointId: string,
  targetSessionId: string,
  createUuid: () => string = randomUUID,
): { entries: SessionStoreEntry[]; checkpointId: string; ids: ReadonlyMap<string, string> } {
  uuid(sourceSessionId);
  uuid(targetSessionId);
  uuid(checkpointId);
  if (sourceSessionId === targetSessionId)
    throw new ClaudeSessionForkError("Fork session must be new.");
  let end = entries.findIndex((entry) => entry.uuid === checkpointId);
  if (end < 0) end = entries.findIndex((entry) => queuedId(entry) === checkpointId);
  if (end < 0) throw new ClaudeSessionForkError("Exact Claude fork checkpoint is missing.");
  const prefix = entries.slice(0, end + 1);
  const rows: SessionStoreEntry[] = [];
  const metadata: SessionStoreEntry[] = [];
  const physical = new Map<string, SessionStoreEntry>();
  const localIds = new Set<string>();

  for (const entry of prefix) {
    if (entry.sessionId !== undefined && entry.sessionId !== sourceSessionId) {
      throw new ClaudeSessionForkError("Claude history contains a different session scope.");
    }
    if (ignoredTypes.has(entry.type)) continue;
    if (entry.type === "atis-latch" || entry.type === "relocated") {
      knownKeys(
        entry,
        new Set(
          entry.type === "atis-latch"
            ? ["type", "sessionId", "atis"]
            : ["type", "sessionId", "relocatedCwd"],
        ),
      );
      metadata.push(entry);
      continue;
    }
    if (!transcriptTypes.has(entry.type)) {
      throw new ClaudeSessionForkError("Unsupported Claude transcript entry type.");
    }
    if (entry.isSidechain === true) continue;
    for (const key of Object.keys(entry)) {
      if (!commonFields.has(key) && !entryFields[entry.type]!.has(key)) {
        throw new ClaudeSessionForkError("Unsupported Claude transcript field.");
      }
    }
    if (
      entry.type === "assistant" &&
      Object.hasOwn(entry, "thinkingDurationMs") &&
      (typeof entry.thinkingDurationMs !== "number" ||
        !Number.isFinite(entry.thinkingDurationMs) ||
        !Number.isInteger(entry.thinkingDurationMs) ||
        entry.thinkingDurationMs < 0)
    ) {
      throw new ClaudeSessionForkError("Unsupported Claude assistant thinking duration.");
    }
    const id = uuid(entry.uuid);
    const previous = physical.get(id);
    if (previous !== undefined && !isDeepStrictEqual(previous, entry)) {
      throw new ClaudeSessionForkError("Conflicting repeated Claude message identifier.");
    }
    physical.set(id, entry);
    localIds.add(id);
    rows.push(entry);
    const virtual = queuedId(entry);
    if (virtual !== undefined) localIds.add(virtual);
  }

  const active = (value: unknown): string => {
    const id = uuid(value);
    if (!physical.has(id))
      throw new ClaudeSessionForkError(
        "Claude history has a missing active reference at the checkpoint.",
      );
    return id;
  };
  const retainedActive = (value: unknown): string => {
    const id = active(value);
    if (physical.get(id)?.type === "progress") {
      throw new ClaudeSessionForkError("Claude compaction references an elided progress entry.");
    }
    return id;
  };

  const checkedParents = new Set<string>();
  for (const entry of rows) {
    const path = new Set<string>();
    let current: unknown = entry.uuid;
    while (current != null) {
      const id = active(current);
      if (checkedParents.has(id)) break;
      if (path.has(id)) throw new ClaudeSessionForkError("Cyclic Claude parent chain.");
      path.add(id);
      current = physical.get(id)!.parentUuid;
    }
    for (const id of path) checkedParents.add(id);
  }

  for (const entry of rows) {
    for (const key of ["parentUuid", "logicalParentUuid", "sourceToolAssistantUUID"]) {
      if (entry[key] != null) active(entry[key]);
    }
    if (entry.forkedFrom !== undefined) {
      const provenance = object(entry.forkedFrom);
      knownKeys(provenance, new Set(["sessionId", "messageUuid"]));
      uuid(provenance.sessionId);
      uuid(provenance.messageUuid);
    }
    if (entry.type === "attachment") {
      if (
        Object.hasOwn(entry, "renderedRole") &&
        entry.renderedRole !== "user" &&
        entry.renderedRole !== "system"
      ) {
        throw new ClaudeSessionForkError("Unsupported Claude attachment rendered role.");
      }
      const attachment = object(entry.attachment);
      if (typeof attachment.type !== "string")
        throw new ClaudeSessionForkError("Unsupported Claude attachment.");
      const fields = Object.hasOwn(attachmentFields, attachment.type)
        ? attachmentFields[attachment.type]
        : undefined;
      if (
        fields === undefined ||
        Object.keys(attachment).some((key) => key !== "type" && !fields.split(" ").includes(key))
      ) {
        throw new ClaudeSessionForkError("Unsupported Claude attachment type or field.");
      }
      if (
        attachment.type === "queued_command" &&
        Object.hasOwn(attachment, "delivery_id") &&
        typeof attachment.delivery_id !== "string"
      ) {
        throw new ClaudeSessionForkError("Unsupported Claude queued delivery identifier.");
      }
      if (
        attachment.type === "agent_listing_delta" &&
        Object.hasOwn(attachment, "builtInTypes") &&
        (!Array.isArray(attachment.builtInTypes) ||
          !attachment.builtInTypes.every((type) => typeof type === "string"))
      ) {
        throw new ClaudeSessionForkError("Unsupported Claude built-in agent types.");
      }
      if (
        attachment.type === "deferred_tools_record" &&
        attachment.nameOnlyAnnouncements !== undefined
      ) {
        uuidList(attachment.nameOnlyAnnouncements);
      }
    }
    if (entry.compactMetadata === undefined) continue;
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") {
      throw new ClaudeSessionForkError("Unexpected Claude compaction metadata location.");
    }
    const compact = object(entry.compactMetadata);
    knownKeys(
      compact,
      new Set([
        "trigger",
        "preTokens",
        "postTokens",
        "cumulativeDroppedTokens",
        "durationMs",
        "preservedMessages",
        "preservedSegment",
      ]),
    );
    if (compact.preservedMessages !== undefined) {
      const preserved = object(compact.preservedMessages);
      knownKeys(preserved, new Set(["anchorUuid", "uuids", "allUuids"]));
      retainedActive(preserved.anchorUuid);
      const kept = uuidList(preserved.uuids);
      if (kept.length === 0 || new Set(kept).size !== kept.length) {
        throw new ClaudeSessionForkError("Invalid Claude preserved-message chain.");
      }
      kept.forEach(retainedActive);
      if (kept.includes(uuid(preserved.anchorUuid)))
        throw new ClaudeSessionForkError("Cyclic Claude compaction anchor.");
      if (preserved.allUuids !== undefined) {
        for (const id of uuidList(preserved.allUuids)) localIds.add(id);
      }
    }
    if (compact.preservedSegment !== undefined) {
      const segment = object(compact.preservedSegment);
      knownKeys(segment, new Set(["headUuid", "anchorUuid", "tailUuid"]));
      const head = retainedActive(segment.headUuid);
      const anchor = retainedActive(segment.anchorUuid);
      let current = retainedActive(segment.tailUuid);
      const visited = new Set<string>();
      while (current !== head) {
        if (current === anchor || visited.has(current))
          throw new ClaudeSessionForkError("Broken Claude preserved-segment chain.");
        visited.add(current);
        current = active(physical.get(current)?.parentUuid);
      }
      if (current === anchor) throw new ClaudeSessionForkError("Cyclic Claude segment anchor.");
    }
  }

  if (!localIds.has(checkpointId) || localIds.has(targetSessionId)) {
    throw new ClaudeSessionForkError("Invalid Claude fork identifier scope.");
  }
  const ids = new Map<string, string>();
  const generated = new Set([sourceSessionId, targetSessionId]);
  for (const original of localIds) {
    const replacement = uuid(createUuid());
    if (generated.has(replacement) || localIds.has(replacement)) {
      throw new ClaudeSessionForkError("Claude fork identifier collision.");
    }
    ids.set(original, replacement);
    generated.add(replacement);
  }
  const mapped = (value: unknown): string => {
    const replacement = ids.get(uuid(value));
    if (replacement === undefined)
      throw new ClaudeSessionForkError("Unmapped Claude history reference.");
    return replacement;
  };
  const retainedParent = (value: unknown): string | null => {
    const visited = new Set<string>();
    let current = value;
    while (current != null) {
      const id = active(current);
      if (visited.has(id)) throw new ClaudeSessionForkError("Cyclic Claude parent chain.");
      visited.add(id);
      const row = physical.get(id)!;
      if (row.type !== "progress") return mapped(id);
      current = row.parentUuid;
    }
    return null;
  };

  const result = rows
    .filter((entry) => entry.type !== "progress")
    .map((entry): SessionStoreEntry => {
      const out: SessionStoreEntry = {
        ...entry,
        uuid: mapped(entry.uuid),
        parentUuid: retainedParent(entry.parentUuid),
        sessionId: targetSessionId,
        isSidechain: false,
        forkedFrom: { sessionId: sourceSessionId, messageUuid: entry.uuid },
      };
      // Native forks elide progress from parentUuid chains, but retain mapped
      // logical-parent and deferred-announcement identities even for elided rows.
      if (entry.logicalParentUuid != null) out.logicalParentUuid = mapped(entry.logicalParentUuid);
      for (const key of ["sourceToolAssistantUUID", "teamName", "agentName", "sessionKind", "slug"])
        delete out[key];
      if (entry.type === "system" && entry.subtype === "model_refusal_fallback")
        out.neutralizedByFork = true;
      if (entry.type === "attachment") {
        const attachment = object(entry.attachment);
        if (attachment.type === "queued_command" && attachment.source_uuid !== undefined) {
          out.attachment = { ...attachment, source_uuid: mapped(attachment.source_uuid) };
        } else if (
          attachment.type === "deferred_tools_record" &&
          attachment.nameOnlyAnnouncements !== undefined
        ) {
          out.attachment = {
            ...attachment,
            nameOnlyAnnouncements: uuidList(attachment.nameOnlyAnnouncements)
              .filter((id) => physical.has(id))
              .map(mapped),
          };
        }
      }
      if (entry.compactMetadata !== undefined) {
        const compact = object(entry.compactMetadata);
        const next = { ...compact };
        if (compact.preservedMessages !== undefined) {
          const kept = object(compact.preservedMessages);
          next.preservedMessages = {
            ...kept,
            anchorUuid: mapped(kept.anchorUuid),
            uuids: uuidList(kept.uuids).map(mapped),
            ...(kept.allUuids === undefined
              ? {}
              : { allUuids: uuidList(kept.allUuids).map(mapped) }),
          };
        }
        if (compact.preservedSegment !== undefined) {
          const kept = object(compact.preservedSegment);
          next.preservedSegment = {
            headUuid: mapped(kept.headUuid),
            anchorUuid: mapped(kept.anchorUuid),
            tailUuid: mapped(kept.tailUuid),
          };
        }
        out.compactMetadata = next;
      }
      return out;
    });
  for (const entry of metadata) result.push({ ...entry, sessionId: targetSessionId });
  return { entries: result, checkpointId: mapped(checkpointId), ids };
}
