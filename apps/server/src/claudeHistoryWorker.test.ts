import { describe, expect, it, vi } from "vite-plus/test";
import {
  getSessionMessages,
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { hasClaudeSessionCompaction, readClaudeForkPrefix } from "./claudeHistoryWorker.ts";
import { prepareClaudeSessionPrefix, remapClaudeSessionPrefix } from "./claudeSessionFork.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, importSessionToStore: vi.fn() };
});

const source = "00000000-0000-4000-8000-0000000003e8";
const target = "00000000-0000-4000-8000-0000000003e9";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function transcript(entries: SessionStoreEntry[]) {
  vi.mocked(importSessionToStore).mockImplementation(async (sessionId, store, options) => {
    expect(options).toEqual({ dir: "/project", includeSubagents: false });
    await store.append({ projectKey: "project", sessionId }, entries);
  });
}

async function project(
  sessionId: string,
  entries: SessionStoreEntry[],
  includeSystemMessages = false,
) {
  const sessionStore: SessionStore = {
    append: async () => {
      throw new Error("Unexpected projection store write.");
    },
    load: async (key) => (key.sessionId === sessionId ? entries : null),
  };
  return getSessionMessages(sessionId, { dir: "/project", includeSystemMessages, sessionStore });
}

async function expectProjectionEquivalent(
  sessionId: string,
  original: SessionStoreEntry[],
  reduced: SessionStoreEntry[],
) {
  for (const includeSystemMessages of [false, true]) {
    const before = await project(sessionId, original, includeSystemMessages);
    const after = await project(sessionId, reduced, includeSystemMessages);
    expect(after.map(({ type, uuid, message }) => ({ type, uuid, message }))).toEqual(
      before.map(({ type, uuid, message }) => ({ type, uuid, message })),
    );
  }
}

describe("Claude compaction diagnostics", () => {
  it("returns only the exact bounded prefix with request binding", async () => {
    const rows: SessionStoreEntry[] = [
      { type: "system", subtype: "compact_boundary", uuid: "boundary" },
      { type: "assistant", uuid: "checkpoint" },
      { type: "user", uuid: "later" },
    ];
    transcript(rows);
    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: "checkpoint",
      targetSessionId: "target",
      requestId: "request",
    });
    expect(result).toEqual({
      sourceSessionId: source,
      checkpointId: "checkpoint",
      targetSessionId: "target",
      requestId: "request",
      projectKey: "project",
      compacted: true,
      entries: [{ type: "assistant", uuid: "checkpoint", parentUuid: null }],
    });
    await expectProjectionEquivalent(source, rows.slice(0, 2), result.entries);
  });
  it("maps queued-command notifications by source UUID and preserves them through fork preparation", async () => {
    const boundary = id(1);
    const task = id(2);
    const attachment = id(3);
    const notification = id(4);
    const checkpoint = id(5);
    const rows: SessionStoreEntry[] = [
      { type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null },
      {
        type: "assistant",
        uuid: task,
        parentUuid: boundary,
        message: { role: "assistant", content: [] },
      },
      {
        type: "attachment",
        uuid: attachment,
        parentUuid: task,
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          source_uuid: notification,
          prompt: "safe fixture prompt",
          origin: "queue",
        },
      },
      {
        type: "assistant",
        uuid: checkpoint,
        parentUuid: attachment,
        message: { role: "assistant", content: [] },
      },
    ];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: checkpoint,
      targetSessionId: target,
      requestId: "request",
    });

    expect(result.entries.map((entry) => entry.uuid)).toEqual([
      boundary,
      task,
      attachment,
      checkpoint,
    ]);
    expect(result.entries.at(-1)?.parentUuid).toBe(attachment);
    expect(result.entries.find((entry) => entry.uuid === attachment)).toMatchObject({
      attachment: { source_uuid: notification },
    });
    await expectProjectionEquivalent(source, rows, result.entries);
    await prepareClaudeSessionPrefix(result.entries, source, checkpoint, target);
  });
  it("prefers a physical UUID over an earlier queued-command source UUID", async () => {
    const boundary = id(11);
    const task = id(12);
    const attachment = id(13);
    const notification = id(14);
    const checkpoint = id(15);
    const rows: SessionStoreEntry[] = [
      { type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null },
      {
        type: "assistant",
        uuid: task,
        parentUuid: boundary,
        message: { role: "assistant", content: [] },
      },
      {
        type: "attachment",
        uuid: attachment,
        parentUuid: task,
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          source_uuid: notification,
          prompt: "safe fixture prompt",
          origin: "queue",
        },
      },
      {
        type: "user",
        uuid: notification,
        parentUuid: attachment,
        message: { role: "user", content: "physical message" },
      },
      {
        type: "assistant",
        uuid: checkpoint,
        parentUuid: notification,
        message: { role: "assistant", content: [] },
      },
    ];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: checkpoint,
      targetSessionId: target,
      requestId: "request",
    });

    expect(result.entries.map((entry) => entry.uuid)).toEqual([
      boundary,
      task,
      notification,
      checkpoint,
    ]);
    expect(result.entries.some((entry) => entry.uuid === attachment)).toBe(false);
    expect(result.entries.find((entry) => entry.uuid === notification)).toMatchObject({
      message: { content: "physical message" },
    });
    await expectProjectionEquivalent(source, rows, result.entries);
    await prepareClaudeSessionPrefix(result.entries, source, checkpoint, target);
  });
  it("rejects an imported project-key traversal", async () => {
    vi.mocked(importSessionToStore).mockImplementation(async (sessionId, store) => {
      await store.append({ projectKey: "../escape", sessionId }, [
        { type: "assistant", uuid: "checkpoint" },
      ]);
    });
    await expect(
      readClaudeForkPrefix(source, {
        dir: "/project",
        upToMessageId: "checkpoint",
        targetSessionId: "target",
        requestId: "request",
      }),
    ).rejects.toThrow("project key");
  });
  it("rejects oversized retained input before serializing a response", async () => {
    transcript([{ type: "assistant", uuid: "checkpoint", message: "x".repeat(24 * 1024 * 1024) }]);
    await expect(
      readClaudeForkPrefix(source, {
        dir: "/project",
        upToMessageId: "checkpoint",
        targetSessionId: "target",
        requestId: "request",
      }),
    ).rejects.toMatchObject({ forkFailureReason: "size-limit" });
  });
  it("ignores oversized history before the last compaction boundary", async () => {
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "last-boundary" };
    const checkpoint = { type: "assistant", uuid: "checkpoint" };
    transcript([
      { type: "user", uuid: "old", message: "x".repeat(24 * 1024 * 1024) },
      { type: "system", subtype: "compact_boundary", uuid: "old-boundary" },
      { type: "assistant", uuid: "old-tail" },
      boundary,
      checkpoint,
    ]);
    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: "checkpoint",
      targetSessionId: "target",
      requestId: "request",
    });
    expect(result.entries).toEqual([{ ...checkpoint, parentUuid: null }]);
  });
  it("still rejects a compacted tail larger than the retained-prefix limit", async () => {
    transcript([
      { type: "system", subtype: "compact_boundary", uuid: "boundary" },
      {
        type: "assistant",
        uuid: "checkpoint",
        message: "x".repeat(24 * 1024 * 1024),
      },
    ]);
    await expect(
      readClaudeForkPrefix(source, {
        dir: "/project",
        upToMessageId: "checkpoint",
        targetSessionId: "target",
        requestId: "request",
      }),
    ).rejects.toMatchObject({ forkFailureReason: "size-limit" });
  });
  it("retains only the last boundary before the checkpoint", async () => {
    const lastBoundary = { type: "system", subtype: "compact_boundary", uuid: "last-boundary" };
    const checkpoint = { type: "assistant", uuid: "checkpoint" };
    const rows: SessionStoreEntry[] = [
      { type: "assistant", uuid: "old" },
      { type: "system", subtype: "compact_boundary", uuid: "first-boundary" },
      { type: "assistant", uuid: "first-tail" },
      lastBoundary,
      checkpoint,
      { type: "system", subtype: "compact_boundary", uuid: "after-checkpoint" },
    ];
    transcript(rows);
    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: "checkpoint",
      targetSessionId: "target",
      requestId: "request",
    });
    expect(result.entries).toEqual([{ ...checkpoint, parentUuid: null }]);
    await expectProjectionEquivalent(source, rows.slice(0, 5), result.entries);
  });
  it.each(["preservedMessages", "preservedSegment"] as const)(
    "retains only the earlier entries required by %s metadata",
    async (kind) => {
      const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
      const source = id(1000);
      const target = id(1001);
      const compactMetadata =
        kind === "preservedMessages"
          ? { preservedMessages: { anchorUuid: id(4), uuids: [id(2)], allUuids: [id(99)] } }
          : { preservedSegment: { headUuid: id(1), anchorUuid: id(4), tailUuid: id(2) } };
      const rows: SessionStoreEntry[] = [
        { type: "user", uuid: id(0), parentUuid: null, sessionId: source },
        { type: "user", uuid: id(1), parentUuid: null, sessionId: source },
        { type: "assistant", uuid: id(2), parentUuid: id(1), sessionId: source },
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: id(3),
          parentUuid: null,
          sessionId: source,
          compactMetadata,
        },
        { type: "user", uuid: id(4), parentUuid: id(3), sessionId: source },
        { type: "assistant", uuid: id(5), parentUuid: id(4), sessionId: source },
      ];
      transcript(rows);
      const result = await readClaudeForkPrefix(source, {
        dir: "/project",
        upToMessageId: id(5),
        targetSessionId: target,
        requestId: "request",
      });
      expect(result.entries.map((entry) => entry.uuid)).toEqual(
        kind === "preservedMessages"
          ? [id(3), id(4), id(2), id(5)]
          : [id(3), id(4), id(1), id(2), id(5)],
      );
      const remapped = remapClaudeSessionPrefix(result.entries, source, id(5), target);
      expect(remapped.ids.has(id(1))).toBe(kind === "preservedSegment");
      expect(remapped.ids.has(id(2))).toBe(true);
      if (kind === "preservedMessages") expect(remapped.ids.has(id(99))).toBe(true);
      await expectProjectionEquivalent(source, rows, result.entries);
    },
  );
  it("retains only preserved-segment entries without walking pre-compaction history", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
    const source = id(1000);
    const target = id(1001);
    const history: SessionStoreEntry[] = [];
    let parentUuid: string | null = null;
    for (let index = 0; index < 260; index++) {
      const uuid = id(index);
      history.push(
        index === 80 || index === 170
          ? {
              type: "system",
              subtype: "compact_boundary",
              uuid,
              parentUuid,
              logicalParentUuid: id(Math.max(index - 5, 0)),
            }
          : {
              type: index % 2 === 0 ? "user" : "assistant",
              uuid,
              parentUuid,
              message: "x".repeat(100 * 1024),
            },
      );
      parentUuid = uuid;
    }
    const head = id(300);
    const middle = id(301);
    const tail = id(302);
    const boundary = id(303);
    const anchor = id(304);
    const checkpoint = id(305);
    const segment = [
      { type: "assistant", uuid: head, parentUuid: id(259) },
      { type: "user", uuid: middle, parentUuid: head },
      { type: "assistant", uuid: tail, parentUuid: middle },
    ] satisfies SessionStoreEntry[];
    const compactBoundary: SessionStoreEntry = {
      type: "system",
      subtype: "compact_boundary",
      uuid: boundary,
      parentUuid: null,
      logicalParentUuid: id(259),
      compactMetadata: {
        preservedSegment: { headUuid: head, anchorUuid: anchor, tailUuid: tail },
      },
    };
    const anchorEntry: SessionStoreEntry = { type: "user", uuid: anchor, parentUuid: boundary };
    const checkpointEntry: SessionStoreEntry = {
      type: "assistant",
      uuid: checkpoint,
      parentUuid: anchor,
    };
    const rows = [...history, ...segment, compactBoundary, anchorEntry, checkpointEntry];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: checkpoint,
      targetSessionId: target,
      requestId: "request",
    });

    expect(result.entries.map((entry) => entry.uuid)).toEqual([
      boundary,
      anchor,
      head,
      middle,
      tail,
      checkpoint,
    ]);
    expect(result.entries.find((entry) => entry.uuid === head)?.parentUuid).toBe(anchor);
    expect(result.entries.find((entry) => entry.uuid === boundary)?.logicalParentUuid).toBeNull();
    expect(
      remapClaudeSessionPrefix(result.entries, source, checkpoint, target).entries,
    ).toHaveLength(6);
    await expectProjectionEquivalent(source, rows, result.entries);
  });

  it("matches SDK projection across two compactions that rewire earlier chains", async () => {
    const rows: SessionStoreEntry[] = [
      { type: "user", uuid: id(1), parentUuid: null, message: { role: "user", content: "one" } },
      {
        type: "assistant",
        uuid: id(2),
        parentUuid: id(1),
        message: { role: "assistant", content: "two" },
      },
      { type: "user", uuid: id(3), parentUuid: id(2), message: { role: "user", content: "three" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: id(4),
        parentUuid: null,
        compactMetadata: { preservedMessages: { anchorUuid: id(5), uuids: [id(2), id(3)] } },
      },
      {
        type: "user",
        uuid: id(5),
        parentUuid: id(4),
        message: { role: "user", content: "summary one" },
      },
      {
        type: "assistant",
        uuid: id(6),
        parentUuid: id(5),
        message: { role: "assistant", content: "six" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: id(10),
        parentUuid: null,
        compactMetadata: {
          preservedSegment: { headUuid: id(5), anchorUuid: id(11), tailUuid: id(6) },
        },
      },
      {
        type: "user",
        uuid: id(11),
        parentUuid: id(10),
        message: { role: "user", content: "summary two" },
      },
      {
        type: "assistant",
        uuid: id(12),
        parentUuid: id(11),
        message: { role: "assistant", content: "twelve" },
      },
    ];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: id(12),
      targetSessionId: target,
      requestId: "request",
    });

    expect((await project(source, rows)).map((message) => message.uuid)).toEqual([
      id(11),
      id(5),
      id(2),
      id(3),
      id(6),
      id(12),
    ]);
    expect(result.entries.map((entry) => entry.uuid)).toEqual([
      id(10),
      id(11),
      id(5),
      id(2),
      id(3),
      id(6),
      id(12),
    ]);
    await expectProjectionEquivalent(source, rows, result.entries);
    await prepareClaudeSessionPrefix(result.entries, source, id(12), target);
  });

  it("does not let a sidechain compaction boundary discard main-thread history", async () => {
    const rows: SessionStoreEntry[] = [
      { type: "user", uuid: id(1), parentUuid: null, message: { role: "user", content: "one" } },
      {
        type: "assistant",
        uuid: id(2),
        parentUuid: id(1),
        message: { role: "assistant", content: "two" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: id(3),
        parentUuid: null,
        isSidechain: true,
      },
      {
        type: "assistant",
        uuid: id(4),
        parentUuid: id(2),
        message: { role: "assistant", content: "four" },
      },
    ];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: id(4),
      targetSessionId: target,
      requestId: "request",
    });

    expect(result.entries.map((entry) => entry.uuid)).toEqual([id(1), id(2), id(4)]);
    await expectProjectionEquivalent(source, rows, result.entries);
    await prepareClaudeSessionPrefix(result.entries, source, id(4), target);
  });

  it("uses the last physical occurrence of a repeated preserved UUID", async () => {
    const rows: SessionStoreEntry[] = [
      { type: "user", uuid: id(1), parentUuid: null, message: { role: "user", content: "one" } },
      {
        type: "assistant",
        uuid: id(2),
        parentUuid: id(1),
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "assistant",
        uuid: id(2),
        parentUuid: id(1),
        message: { role: "assistant", content: "latest" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: id(3),
        parentUuid: null,
        compactMetadata: { preservedMessages: { anchorUuid: id(4), uuids: [id(2)] } },
      },
      {
        type: "user",
        uuid: id(4),
        parentUuid: id(3),
        message: { role: "user", content: "summary" },
      },
      {
        type: "assistant",
        uuid: id(5),
        parentUuid: id(4),
        message: { role: "assistant", content: "checkpoint" },
      },
    ];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: id(5),
      targetSessionId: target,
      requestId: "request",
    });

    expect(result.entries.find((entry) => entry.uuid === id(2))?.message).toEqual({
      role: "assistant",
      content: "latest",
    });
    await expectProjectionEquivalent(source, rows, result.entries);
    await prepareClaudeSessionPrefix(result.entries, source, id(5), target);
  });

  it("retains hidden compaction references needed to prepare an equivalent fork", async () => {
    const rows: SessionStoreEntry[] = [
      { type: "user", uuid: id(1), parentUuid: null, message: { role: "user", content: "head" } },
      {
        type: "assistant",
        uuid: id(2),
        parentUuid: id(1),
        message: { role: "assistant", content: "two" },
      },
      { type: "user", uuid: id(3), parentUuid: id(2), message: { role: "user", content: "three" } },
      {
        type: "user",
        uuid: id(4),
        parentUuid: id(3),
        isMeta: true,
        message: { role: "user", content: "hidden meta" },
      },
      {
        type: "attachment",
        uuid: id(5),
        parentUuid: id(4),
        attachment: { type: "output_style", style: "concise" },
      },
      {
        type: "attachment",
        uuid: id(6),
        parentUuid: id(5),
        attachment: { type: "command_permissions", allowedTools: [] },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: id(7),
        parentUuid: null,
        compactMetadata: {
          preservedMessages: {
            anchorUuid: id(8),
            uuids: [id(1), id(2), id(3), id(4), id(5), id(6)],
          },
          preservedSegment: { headUuid: id(1), anchorUuid: id(8), tailUuid: id(6) },
        },
      },
      {
        type: "user",
        uuid: id(8),
        parentUuid: id(7),
        message: { role: "user", content: "anchor" },
      },
      {
        type: "assistant",
        uuid: id(9),
        parentUuid: id(8),
        message: { role: "assistant", content: "checkpoint" },
      },
    ];
    transcript(rows);

    const result = await readClaudeForkPrefix(source, {
      dir: "/project",
      upToMessageId: id(9),
      targetSessionId: target,
      requestId: "request",
    });

    expect(result.entries.map((entry) => entry.uuid)).toContain(id(6));
    await expectProjectionEquivalent(source, rows, result.entries);
    await prepareClaudeSessionPrefix(result.entries, source, id(9), target);
  });

  it("detects a raw compact boundary before the exact checkpoint", async () => {
    transcript([
      { type: "system", subtype: "compact_boundary", uuid: "boundary" },
      { type: "assistant", uuid: "checkpoint" },
    ]);
    expect(
      await hasClaudeSessionCompaction("session", { dir: "/project", upToMessageId: "checkpoint" }),
    ).toBe(true);
  });

  it("ignores a sidechain-only compact boundary when main-thread proof is required", async () => {
    transcript([
      { type: "system", subtype: "compact_boundary", uuid: "boundary", isSidechain: true },
      { type: "assistant", uuid: "checkpoint" },
    ]);
    expect(
      await hasClaudeSessionCompaction("session", {
        dir: "/project",
        upToMessageId: "checkpoint",
        mainThreadOnly: true,
      }),
    ).toBe(false);
    // Diagnostics keep counting any raw boundary.
    expect(
      await hasClaudeSessionCompaction("session", { dir: "/project", upToMessageId: "checkpoint" }),
    ).toBe(true);
  });

  it("does not attribute a later compaction to an earlier checkpoint", async () => {
    transcript([
      { type: "assistant", uuid: "checkpoint" },
      { type: "system", subtype: "compact_boundary", uuid: "boundary" },
    ]);
    expect(
      await hasClaudeSessionCompaction("session", { dir: "/project", upToMessageId: "checkpoint" }),
    ).toBe(false);
  });

  it("does not guess when the checkpoint is missing", async () => {
    transcript([{ type: "system", subtype: "compact_boundary", uuid: "boundary" }]);
    await expect(
      hasClaudeSessionCompaction("session", { dir: "/project", upToMessageId: "missing" }),
    ).rejects.toThrow("checkpoint was not found");
  });
});
