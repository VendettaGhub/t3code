import { expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { runClaudeHistoryWorker } from "./claudeHistoryWorker.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { NodeServices } from "@effect/platform-node";
import { forkClaudeSessionVerified } from "./claudeForkV2.ts";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = NodeFSP;
const { tmpdir } = NodeOS;
const { join } = NodePath;

it("requires an explicit provider home for bounded fork reads", async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    await expect(runClaudeHistoryWorker("readForkPrefix", "source", "{}")).rejects.toThrow(
      "Explicit Claude provider home is required",
    );
  } finally {
    if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

effectIt.live.each([false, true])(
  "forks a real isolated transcript and fails closed on unknown fields, compacted=%s",
  (compacted) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "t3-v2-verified-fork-")));
      const configDir = join(root, "claude");
      const dir = join(root, "workspace");
      const project = join(configDir, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
      const sessionId = "00000000-0000-4000-8000-000000000010";
      const userId = "00000000-0000-4000-8000-000000000011";
      const assistantId = "00000000-0000-4000-8000-000000000012";
      const entries: SessionStoreEntry[] = [
        {
          type: "user",
          uuid: userId,
          parentUuid: null,
          sessionId,
          message: { role: "user", content: "retained question" },
        },
        {
          type: "assistant",
          uuid: assistantId,
          parentUuid: userId,
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
        },
      ];
      if (compacted) {
        const boundaryId = "00000000-0000-4000-8000-000000000013";
        entries[0]!.parentUuid = boundaryId;
        entries[0]!.isCompactSummary = true;
        entries.unshift({
          type: "system",
          subtype: "compact_boundary",
          uuid: boundaryId,
          parentUuid: null,
          sessionId,
        });
      }
      const source = join(project, `${sessionId}.jsonl`);
      try {
        yield* Effect.promise(() => mkdir(project, { recursive: true }));
        yield* Effect.promise(() => mkdir(dir));
        const bytes = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        yield* Effect.promise(() => writeFile(source, bytes));
        const run = () =>
          forkClaudeSessionVerified({
            sessionId,
            dir,
            configDir,
            environment: {},
            upToMessageId: assistantId,
          }).pipe(Effect.provide(NodeServices.layer));
        const result = yield* run();
        expect(result.sessionId).not.toBe(sessionId);
        const fork = JSON.parse(
          (yield* Effect.promise(() =>
            readFile(join(project, `${result.sessionId}.jsonl`), "utf8"),
          ))
            .trim()
            .split("\n")
            .at(-1)!,
        );
        expect(fork.sessionId).toBe(result.sessionId);
        expect(fork.uuid).not.toBe(assistantId);
        expect(fork.message).toEqual(entries.at(-1)!.message);
        expect(yield* Effect.promise(() => readFile(source, "utf8"))).toBe(bytes);
        entries.at(-1)!.unverifiedMetadata = true;
        yield* Effect.promise(() =>
          writeFile(source, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"),
        );
        expect(yield* Effect.flip(run())).toMatchObject({
          cause: { message: "Unsupported Claude transcript field." },
        });
        expect((yield* Effect.promise(() => readdir(project))).sort()).toEqual(
          [`${sessionId}.jsonl`, `${result.sessionId}.jsonl`].sort(),
        );
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }),
);
