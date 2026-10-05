import { describe, expect, it } from "vite-plus/test";
import {
  InMemorySessionStore,
  forkSession,
  getSessionMessages,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { remapClaudeSessionPrefix, prepareClaudeSessionPrefix } from "./claudeSessionFork.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const source = id(1000);
const target = id(1001);
function fixture(): SessionStoreEntry[] {
  const row = (n: number, parent: number | null, type: string, extra = {}) => ({
    uuid: id(n),
    parentUuid: parent === null ? null : id(parent),
    sessionId: source,
    type,
    ...extra,
  });
  return [
    row(1, null, "user", { message: { role: "user", content: "Invented request" } }),
    row(2, 1, "assistant", {
      message: { role: "assistant", content: [{ type: "text", text: `Keep literal ${id(1)}` }] },
    }),
    row(3, 2, "user", { message: { role: "user", content: "Retained follow-up" } }),
    row(4, null, "system", {
      subtype: "compact_boundary",
      logicalParentUuid: id(3),
      compactMetadata: {
        trigger: "auto",
        preTokens: 100,
        preservedMessages: {
          anchorUuid: id(5),
          uuids: [id(2), id(3)],
          allUuids: [id(2), id(3), id(99)],
        },
      },
    }),
    row(5, 4, "user", {
      isCompactSummary: true,
      message: { role: "user", content: "Invented summary" },
    }),
    row(6, 5, "assistant", { message: { role: "assistant", content: "Checkpoint" } }),
    row(7, 6, "user", { message: { role: "user", content: "Must not be copied" } }),
  ];
}
const fork = (rows = fixture()) => remapClaudeSessionPrefix(rows, source, id(6), target);

describe("Claude compacted prefix remapping", () => {
  it.each([0, 317, Number.MAX_SAFE_INTEGER])(
    "preserves assistant thinkingDurationMs %j unchanged through preparation",
    async (thinkingDurationMs) => {
      const rows = fixture().slice(0, 6);
      rows[5]!.thinkingDurationMs = thinkingDurationMs;
      const original = structuredClone(rows);
      const prepared = await prepareClaudeSessionPrefix(rows, source, id(6), target);
      expect(prepared.entries[5]!.thinkingDurationMs).toBe(thinkingDurationMs);
      expect(rows).toEqual(original);
    },
  );
  it.each(
    [undefined, null, "317", true, {}, [], -1, 0.5, NaN, Infinity, -Infinity].map(
      (thinkingDurationMs) => ({ thinkingDurationMs }),
    ),
  )(
    "rejects invalid assistant thinkingDurationMs $thinkingDurationMs",
    ({ thinkingDurationMs }) => {
      const rows = fixture();
      rows[5]!.thinkingDurationMs = thinkingDurationMs;
      expect(() => fork(rows)).toThrow("Unsupported Claude assistant thinking duration");
    },
  );
  it("rejects thinkingDurationMs on other row types and unknown assistant fields", () => {
    const rows = fixture();
    rows[4]!.thinkingDurationMs = 317;
    expect(() => fork(rows)).toThrow("Unsupported Claude transcript field");
    delete rows[4]!.thinkingDurationMs;
    rows[5]!.thinkingDurationMs = 317;
    rows[5]!.futureGraph = { references: [id(2)] };
    expect(() => fork(rows)).toThrow("Unsupported Claude transcript field");
  });
  it("verifies the exact projected assistant checkpoint before staging", async () => {
    const rows = fixture().slice(0, 6);
    const prepared = await prepareClaudeSessionPrefix(rows, source, id(6), target);
    expect(prepared.entries).toHaveLength(6);
    rows[5] = { ...rows[5]!, type: "user", message: { role: "user", content: "Not completed" } };
    await expect(prepareClaudeSessionPrefix(rows, source, id(6), target)).rejects.toThrow(
      "assistant checkpoint",
    );
  });
  it("prepares a compacted prefix that starts at its boundary", async () => {
    const makeRow = (n: number, parent: number | null, type: string, extra = {}) => ({
      uuid: id(n),
      parentUuid: parent === null ? null : id(parent),
      sessionId: source,
      type,
      ...extra,
    });
    const rows = [
      makeRow(40, null, "system", { subtype: "compact_boundary" }),
      makeRow(41, 40, "user", {
        isCompactSummary: true,
        message: { role: "user", content: "Boundary summary" },
      }),
      makeRow(42, 41, "assistant", { message: { role: "assistant", content: "Checkpoint" } }),
    ];
    const prepared = await prepareClaudeSessionPrefix(rows, source, id(42), target);
    expect(prepared.entries).toHaveLength(3);
  });
  it("preserves assistant attributionPlugin metadata unchanged through preparation", async () => {
    const rows = fixture().slice(0, 6);
    rows[5]!.attributionPlugin = "superpowers";

    const prepared = await prepareClaudeSessionPrefix(rows, source, id(6), target);

    expect(prepared.entries[5]!.attributionPlugin).toBe("superpowers");
  });
  it("preserves SDK-projected compacted context that SDK 0.3.276 fork loses", async () => {
    const sessionStore = new InMemorySessionStore();
    const dir = "C:/anonymized-fixture";
    const projectKey = dir.replace(/[^a-zA-Z0-9]/g, "-");
    const rows = fixture().slice(0, 6);
    await sessionStore.append({ projectKey, sessionId: source }, rows);
    const original = await getSessionMessages(source, { dir, sessionStore });
    expect(original.map((row) => row.uuid)).toEqual([id(5), id(2), id(3), id(6)]);
    const transformed = fork(rows);
    await sessionStore.append({ projectKey, sessionId: target }, transformed.entries);
    const actual = await getSessionMessages(target, { dir, sessionStore });
    expect(actual.map((row) => ({ type: row.type, message: row.message }))).toEqual(
      original.map((row) => ({ type: row.type, message: row.message })),
    );
    expect(actual.map((row) => row.uuid)).toEqual(
      original.map((row) => transformed.ids.get(row.uuid)),
    );
    const native = await forkSession(source, { dir, sessionStore, upToMessageId: id(6) });
    const nativeMessages = await getSessionMessages(native.sessionId, { dir, sessionStore });
    expect(nativeMessages).toHaveLength(2);
    expect(sessionStore.getEntries({ projectKey, sessionId: source })).toEqual(rows);
  });
  it("preserves opaque payloads, exact cutoff, provenance and missing allUuids", () => {
    const original = fixture();
    const before = structuredClone(original);
    const result = fork(original);
    expect(original).toEqual(before);
    expect(result.entries).toHaveLength(6);
    expect(result.ids.has(id(7))).toBe(false);
    expect(new Set(result.ids.values()).size).toBe(result.ids.size);
    result.entries.forEach((row, index) => {
      expect(row.message).toEqual(original[index]!.message);
      expect(row.sessionId).toBe(target);
      expect(row.forkedFrom).toEqual({ sessionId: source, messageUuid: original[index]!.uuid });
    });
    expect(result.entries[3]!.compactMetadata).toEqual({
      trigger: "auto",
      preTokens: 100,
      preservedMessages: {
        anchorUuid: result.ids.get(id(5)),
        uuids: [result.ids.get(id(2)), result.ids.get(id(3))],
        allUuids: [result.ids.get(id(2)), result.ids.get(id(3)), result.ids.get(id(99))],
      },
    });
    expect(result.entries.some((row) => row.uuid === result.ids.get(id(99)))).toBe(false);
    expect(result.checkpointId).toBe(result.entries[5]!.uuid);
  });

  it.each(["parentUuid", "logicalParentUuid"])("rejects a missing active %s", (field) => {
    const rows = fixture();
    rows[5]![field] = id(7);
    expect(() => fork(rows)).toThrow("missing active reference");
  });

  it("rejects unknown structural containers even without UUID-like field names", () => {
    const rows = fixture();
    rows[5]!.futureGraph = { references: [id(2)] };
    expect(() => fork(rows)).toThrow("Unsupported Claude transcript field");
  });

  it("rejects unknown attachment types", () => {
    const rows = fixture();
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      attachment: { type: "future_graph", references: [id(2)] },
    });
    expect(() => fork(rows)).toThrow("Unsupported Claude attachment");
  });

  it("rejects an unknown compaction field without touching the input", () => {
    const rows = fixture();
    rows[3]!.compactMetadata = { trigger: "auto", futureReferences: [id(2)] };
    expect(() => fork(rows)).toThrow("Unsupported Claude compaction metadata field");
  });

  it.each([id(89), "arbitrary-delivery", ""])(
    "preserves queued attachment string delivery_id %j through preparation",
    async (deliveryId) => {
      const rows = fixture().slice(0, 6);
      rows.splice(3, 0, {
        type: "attachment",
        uuid: id(80),
        parentUuid: id(3),
        sessionId: source,
        version: "2.1.286",
        attachment: {
          type: "queued_command",
          prompt: "Invented queued request",
          source_uuid: id(88),
          delivery_id: deliveryId,
          commandMode: "prompt",
          origin: { type: "remote" },
          timestamp: "2026-10-01T22:32:28.142Z",
          usage: { input_tokens: 1 },
        },
      });
      const before = structuredClone(rows);
      const prepared = await prepareClaudeSessionPrefix(rows, source, id(6), target);
      const attachment = prepared.entries[3]!.attachment as Record<string, unknown>;
      expect(attachment.delivery_id).toBe(deliveryId);
      expect(attachment.source_uuid).toBe(prepared.ids.get(id(88)));
      expect(rows).toEqual(before);
    },
  );

  it.each([null, {}, 1, true, [], undefined].map((deliveryId) => ({ deliveryId })))(
    "rejects queued attachment non-string delivery_id $deliveryId",
    ({ deliveryId }) => {
      const rows = fixture();
      rows.splice(3, 0, {
        type: "attachment",
        uuid: id(80),
        parentUuid: id(3),
        sessionId: source,
        attachment: {
          type: "queued_command",
          source_uuid: id(88),
          delivery_id: deliveryId,
          prompt: "Invented queue",
        },
      });
      expect(() => fork(rows)).toThrow("Unsupported Claude queued delivery identifier");
    },
  );

  it("still rejects unknown queued attachment fields with a valid delivery_id", () => {
    const rows = fixture();
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      attachment: {
        type: "queued_command",
        source_uuid: id(88),
        delivery_id: id(89),
        prompt: "Invented queue",
        futureReferences: [id(2)],
      },
    });
    expect(() => fork(rows)).toThrow("Unsupported Claude attachment type or field");
  });

  it("preserves agent listing string-array builtInTypes through preparation", async () => {
    const rows = fixture().slice(0, 6);
    const builtInTypes = ["InventedExplore", "InventedPlan", id(89)];
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      attachment: {
        type: "agent_listing_delta",
        addedTypes: [],
        addedLines: [],
        builtInTypes,
        removedTypes: [],
        isInitial: true,
        showConcurrencyNote: false,
      },
    });
    const before = structuredClone(rows);
    const prepared = await prepareClaudeSessionPrefix(rows, source, id(6), target);
    const attachment = prepared.entries[3]!.attachment as Record<string, unknown>;
    expect(attachment.builtInTypes).toEqual(builtInTypes);
    expect(rows).toEqual(before);
  });

  it.each(
    [null, {}, 1, true, "Explore", ["Explore", 1], undefined].map((builtInTypes) => ({
      builtInTypes,
    })),
  )("rejects agent listing non-string-array builtInTypes $builtInTypes", ({ builtInTypes }) => {
    const rows = fixture();
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      attachment: { type: "agent_listing_delta", builtInTypes },
    });
    expect(() => fork(rows)).toThrow("Unsupported Claude built-in agent types");
  });

  it("still rejects unknown agent listing fields with valid builtInTypes", () => {
    const rows = fixture();
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      attachment: {
        type: "agent_listing_delta",
        builtInTypes: ["InventedPlan"],
        futureReferences: [id(2)],
      },
    });
    expect(() => fork(rows)).toThrow("Unsupported Claude attachment type or field");
  });

  it.each(["user", "system"])(
    "preserves queued attachment renderedRole %s",
    async (renderedRole) => {
      const rows = fixture().slice(0, 6);
      rows.splice(3, 0, {
        type: "attachment",
        uuid: id(80),
        parentUuid: id(3),
        sessionId: source,
        renderedRole,
        attachment: { type: "queued_command", source_uuid: id(88), prompt: "Invented queue" },
      });
      const before = structuredClone(rows);

      const prepared = await prepareClaudeSessionPrefix(rows, source, id(6), target);

      expect(prepared.entries[3]!.renderedRole).toBe(renderedRole);
      expect(prepared.entries[3]!.attachment).toEqual({
        type: "queued_command",
        source_uuid: prepared.ids.get(id(88)),
        prompt: "Invented queue",
      });
      expect(rows).toEqual(before);
    },
  );

  it.each(
    ["assistant", null, {}, 1, true, [], undefined].map((renderedRole) => ({ renderedRole })),
  )("rejects invalid queued attachment renderedRole $renderedRole", ({ renderedRole }) => {
    const rows = fixture();
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      renderedRole,
      attachment: { type: "queued_command", source_uuid: id(88), prompt: "Invented queue" },
    });
    expect(() => fork(rows)).toThrow("Unsupported Claude attachment rendered role");
  });

  it("rejects unknown queued attachment fields even with a valid renderedRole", () => {
    const rows = fixture();
    rows.splice(3, 0, {
      type: "attachment",
      uuid: id(80),
      parentUuid: id(3),
      sessionId: source,
      renderedRole: "system",
      futureField: "unknown",
      attachment: { type: "queued_command", source_uuid: id(88), prompt: "Invented queue" },
    });
    expect(() => fork(rows)).toThrow("Unsupported Claude transcript field");
  });

  it("rejects renderedRole outside attachment rows", () => {
    const rows = fixture();
    rows[5]!.renderedRole = "system";
    expect(() => fork(rows)).toThrow("Unsupported Claude transcript field");
  });

  it("remaps virtual queued IDs and preserves physical aliases", () => {
    for (const alias of [id(3), id(88)]) {
      const rows = fixture();
      rows.splice(3, 0, {
        type: "attachment",
        uuid: id(80),
        parentUuid: id(3),
        sessionId: source,
        attachment: {
          type: "queued_command",
          source_uuid: alias,
          prompt: "Invented queued message",
        },
      });
      const result = fork(rows);
      expect(result.entries[3]!.attachment).toEqual({
        type: "queued_command",
        source_uuid: result.ids.get(alias),
        prompt: "Invented queued message",
      });
      expect(result.entries.filter((row) => row.uuid === result.ids.get(alias))).toHaveLength(
        alias === id(3) ? 1 : 0,
      );
    }
  });

  it("preserves a second legacy compaction and rejects a broken segment", async () => {
    const rows = fixture().slice(0, 6);
    rows.push(
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: id(10),
        parentUuid: null,
        sessionId: source,
        compactMetadata: {
          trigger: "auto",
          preTokens: 200,
          preservedSegment: { headUuid: id(5), tailUuid: id(6), anchorUuid: id(11) },
        },
      },
      {
        type: "user",
        uuid: id(11),
        parentUuid: id(10),
        sessionId: source,
        isCompactSummary: true,
        message: { role: "user", content: "Second invented summary" },
      },
      {
        type: "assistant",
        uuid: id(12),
        parentUuid: id(11),
        sessionId: source,
        message: { role: "assistant", content: "Second checkpoint" },
      },
    );
    const result = remapClaudeSessionPrefix(rows, source, id(12), target);
    const sessionStore = new InMemorySessionStore();
    const dir = "C:/anonymized-fixture";
    const projectKey = dir.replace(/[^a-zA-Z0-9]/g, "-");
    await sessionStore.append({ projectKey, sessionId: source }, rows);
    await sessionStore.append({ projectKey, sessionId: target }, result.entries);
    const original = await getSessionMessages(source, { dir, sessionStore });
    const actual = await getSessionMessages(target, { dir, sessionStore });
    expect(original.length).toBeGreaterThan(2);
    expect(actual.map((row) => row.message)).toEqual(original.map((row) => row.message));
    expect(actual.map((row) => row.uuid)).toEqual(original.map((row) => result.ids.get(row.uuid)));
    rows[5]!.parentUuid = id(1);
    expect(() => remapClaudeSessionPrefix(rows, source, id(12), target)).toThrow();
  });

  it("uses SDK retention semantics for deferred announcements and elides progress", async () => {
    const rows = fixture().slice(0, 3);
    rows.push(
      { type: "progress", uuid: id(70), parentUuid: id(3), sessionId: source },
      {
        type: "attachment",
        uuid: id(71),
        parentUuid: id(70),
        sessionId: source,
        attachment: {
          type: "deferred_tools_record",
          nameOnlyAnnouncements: [id(2), id(70), id(99)],
          toolInputCopies: [{ input_schema: { properties: { session_id: { const: id(2) } } } }],
        },
      },
      {
        type: "assistant",
        uuid: id(6),
        parentUuid: id(71),
        logicalParentUuid: id(70),
        sessionId: source,
        sourceToolAssistantUUID: id(2),
        message: { role: "assistant", content: "Checkpoint" },
      },
    );
    const result = fork(rows);
    expect(result.entries.some((row) => row.type === "progress")).toBe(false);
    expect(result.entries[3]!.parentUuid).toBe(result.ids.get(id(3)));
    expect(result.entries[4]!.sourceToolAssistantUUID).toBeUndefined();
    expect(result.entries[4]!.logicalParentUuid).toBe(result.ids.get(id(70)));
    const attachment = result.entries[3]!.attachment as Record<string, unknown>;
    expect(attachment.nameOnlyAnnouncements).toEqual([
      result.ids.get(id(2)),
      result.ids.get(id(70)),
    ]);
    expect(attachment.toolInputCopies).toEqual(
      (rows[4]!.attachment as Record<string, unknown>).toolInputCopies,
    );
    const sessionStore = new InMemorySessionStore();
    const dir = "C:/anonymized-fixture";
    const projectKey = dir.replace(/[^a-zA-Z0-9]/g, "-");
    await sessionStore.append({ projectKey, sessionId: source }, rows);
    const native = await forkSession(source, { dir, sessionStore, upToMessageId: id(6) });
    const nativeRows = sessionStore.getEntries({ projectKey, sessionId: native.sessionId });
    const nativeAttachment = nativeRows.find((row) => row.type === "attachment")!
      .attachment as Record<string, unknown>;
    expect(nativeAttachment.nameOnlyAnnouncements).toHaveLength(2);
    expect(nativeAttachment.toolInputCopies).toEqual(attachment.toolInputCopies);
  });

  it("rejects cyclic active parent chains", () => {
    const rows = fixture();
    rows[0]!.parentUuid = id(2);
    expect(() => fork(rows)).toThrow("Cyclic Claude parent chain");
  });
});
