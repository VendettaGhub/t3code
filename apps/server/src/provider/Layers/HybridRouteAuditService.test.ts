import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterEach, expect, vi } from "vite-plus/test";

import {
  advanceHybridAuditTail,
  createHybridAuditTailState,
  INITIAL_AUDIT_TAIL_BYTES,
  HybridRouteAuditServiceLive,
} from "./HybridRouteAuditService.ts";
import {
  consumeHybridAuditRecord,
  createHybridAuditState,
} from "../Services/ProviderLimitsService.ts";

afterEach(() => vi.unstubAllEnvs());

it.effect("does not prevent server startup when the optional audit file does not exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-audit-test-" });
      vi.stubEnv("T3_HYBRID_ROUTER_AUDIT_LOG", path.join(directory, "not-created-yet.ndjson"));
      const context = yield* Layer.build(HybridRouteAuditServiceLive);
      expect(context).toBeDefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const firstFile = { device: "1", inode: "10" };
const replacementFile = { device: "1", inode: "11" };

it("continues an appended partial record without losing the completed record", () => {
  const first = advanceHybridAuditTail(
    createHybridAuditTailState({ size: 0, identity: firstFile }),
    { nextSize: 18, identity: firstFile, chunk: '{"event":"route"}' },
  );
  const second = advanceHybridAuditTail(first.state, {
    nextSize: 40,
    identity: firstFile,
    chunk: '\n{"event":"result"}\n',
  });

  expect(first.completeLines).toEqual([]);
  expect(second.completeLines).toEqual(['{"event":"route"}', '{"event":"result"}']);
  expect(second.state.remainder).toBe("");
});

it("discards an incomplete tail after truncation instead of prepending it", () => {
  const partial = advanceHybridAuditTail(
    createHybridAuditTailState({ size: 0, identity: firstFile }),
    { nextSize: 18, identity: firstFile, chunk: '{"event":"old"}' },
  );
  const afterTruncate = advanceHybridAuditTail(partial.state, {
    nextSize: 10,
    identity: firstFile,
    chunk: '{"event":"new"}\n',
  });

  expect(afterTruncate.completeLines).toEqual(['{"event":"new"}']);
  expect(afterTruncate.state.remainder).toBe("");
});

it("reads the new prefix when an atomic replacement is the same or larger size", () => {
  const old = advanceHybridAuditTail(createHybridAuditTailState({ size: 8, identity: firstFile }), {
    nextSize: 8,
    identity: firstFile,
    chunk: '{"old":1}\n',
  });
  for (const nextSize of [8, 24]) {
    const replaced = advanceHybridAuditTail(old.state, {
      nextSize,
      identity: replacementFile,
      chunk: '{"new":1}\n',
    });

    expect(replaced.completeLines).toEqual(['{"new":1}']);
    expect(replaced.state.offset).toBe(nextSize);
  }
});

it("resets a same-inode copy-truncate regrow before carrying an old remainder", () => {
  const old = advanceHybridAuditTail(
    createHybridAuditTailState({
      size: 0,
      identity: firstFile,
      continuityFingerprint: "old-prefix",
    }),
    {
      nextSize: 32,
      identity: firstFile,
      chunk: '{"event":"old"',
      nextContinuityFingerprint: "old-prefix",
    },
  );
  const replaced = advanceHybridAuditTail(old.state, {
    nextSize: 32,
    identity: firstFile,
    continuityFingerprint: "new-prefix",
    chunk: '{"event":"new"}\n',
    nextContinuityFingerprint: "new-prefix",
  });

  expect(replaced.completeLines).toEqual(['{"event":"new"}']);
  expect(replaced.state.remainder).toBe("");
});

it("keeps a complete first record when the initial tail starts after a newline", () => {
  const initialSize = INITIAL_AUDIT_TAIL_BYTES + 1;
  const result = advanceHybridAuditTail(
    createHybridAuditTailState({ size: initialSize, identity: firstFile }),
    {
      nextSize: initialSize + 16,
      identity: firstFile,
      precedingByte: "\n",
      chunk: '{"event":"route"}\n',
    },
  );

  expect(result.completeLines).toEqual(['{"event":"route"}']);
});

it("continues dropping an initial partial record until its newline arrives", () => {
  const initialSize = INITIAL_AUDIT_TAIL_BYTES + 1;
  const partial = advanceHybridAuditTail(
    createHybridAuditTailState({ size: initialSize, identity: firstFile }),
    {
      nextSize: initialSize + 12,
      identity: firstFile,
      precedingByte: "x",
      chunk: '{"event":"old"',
    },
  );
  const completed = advanceHybridAuditTail(partial.state, {
    nextSize: initialSize + 30,
    identity: firstFile,
    chunk: '}\n{"event":"new"}\n',
  });

  expect(completed.completeLines).toEqual(['{"event":"new"}']);
});

it("feeds retained NDJSON lines into the route correlation state", () => {
  const result = advanceHybridAuditTail(
    createHybridAuditTailState({ size: 0, identity: firstFile }),
    {
      nextSize: 256,
      identity: firstFile,
      chunk:
        '{"event":"route","requestId":"req-1","path":"/v1/messages","targetProvider":"anthropic","targetModel":"claude-fable-5"}\n' +
        '{"event":"result","requestId":"req-1","targetProvider":"gpt","targetModel":"gpt-5.6-sol","statusCode":200,"timestamp":"2026-09-06T12:00:00.000Z"}\n',
    },
  );
  const state = createHybridAuditState();

  const actualRoute = result.completeLines.reduce<ReturnType<typeof consumeHybridAuditRecord>>(
    (route, line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return consumeHybridAuditRecord(state, parsed) ?? route;
    },
    null,
  );

  expect(actualRoute?.model).toBe("gpt-5.6-sol");
});
