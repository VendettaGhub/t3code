// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  consumeHybridAuditRecord,
  createHybridAuditState,
  ProviderLimitsService,
} from "../Services/ProviderLimitsService.ts";

const INITIAL_AUDIT_TAIL_BYTES = 256 * 1024;
const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

interface TailState {
  readonly offset: number;
  readonly remainder: string;
}

async function readRange(path: string, offset: number, length: number): Promise<string> {
  const handle = await NodeFS.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export const HybridRouteAuditServiceLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const auditPath = process.env.T3_HYBRID_ROUTER_AUDIT_LOG?.trim();
    if (!auditPath) return;
    const fs = yield* FileSystem.FileSystem;
    const limits = yield* ProviderLimitsService;
    const auditState = createHybridAuditState();

    const stat = yield* Effect.tryPromise({
      try: () => NodeFS.stat(auditPath),
      catch: () => undefined,
    }).pipe(Effect.option);
    const size = stat._tag === "Some" && stat.value !== undefined ? stat.value.size : 0;
    const initialOffset = Math.max(0, size - INITIAL_AUDIT_TAIL_BYTES);
    const tailState = yield* Ref.make<TailState>({ offset: initialOffset, remainder: "" });

    const ingestLine = Effect.fn("HybridRouteAuditService.ingestLine")(function* (line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      const decoded = decodeJson(trimmed);
      if (Exit.isFailure(decoded)) return;
      const route = consumeHybridAuditRecord(auditState, decoded.value);
      if (route !== null) yield* limits.updateActualRoute(route);
    });

    const readDelta = Effect.gen(function* () {
      const current = yield* Ref.get(tailState);
      const nextStat = yield* Effect.tryPromise({
        try: () => NodeFS.stat(auditPath),
        catch: () => undefined,
      });
      if (nextStat === undefined) return;
      const offset = nextStat.size < current.offset ? 0 : current.offset;
      const length = nextStat.size - offset;
      if (length <= 0) return;
      const appended = yield* Effect.tryPromise({
        try: () => readRange(auditPath, offset, length),
        catch: () => "",
      });
      const combined = current.remainder + appended;
      const lines = combined.split("\n");
      const remainder = lines.pop() ?? "";
      yield* Ref.set(tailState, { offset: nextStat.size, remainder });
      const completeLines = offset > 0 && current.offset === initialOffset ? lines.slice(1) : lines;
      yield* Effect.forEach(completeLines, ingestLine, { discard: true });
    });

    yield* readDelta;
    yield* Stream.runForEach(fs.watch(auditPath), () => readDelta).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  }),
);
