import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  consumeHybridAuditRecord,
  createHybridAuditState,
  ProviderLimitsService,
} from "../Services/ProviderLimitsService.ts";

export const INITIAL_AUDIT_TAIL_BYTES = 256 * 1024;
const CONTINUITY_FINGERPRINT_BYTES = 64;
const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface HybridAuditFileIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface HybridAuditTailState {
  readonly offset: number;
  readonly remainder: string;
  readonly identity?: HybridAuditFileIdentity | undefined;
  readonly initialBoundaryPending: boolean;
  readonly initialBoundaryNeedsDrop: boolean;
  readonly continuityFingerprint?: string | undefined;
}

export interface HybridAuditTailChunk {
  readonly nextSize: number;
  readonly identity?: HybridAuditFileIdentity | undefined;
  readonly chunk: string;
  readonly precedingByte?: string | undefined;
  readonly continuityFingerprint?: string | undefined;
  readonly nextContinuityFingerprint?: string | undefined;
}

export interface HybridAuditTailAdvance {
  readonly state: HybridAuditTailState;
  readonly completeLines: ReadonlyArray<string>;
}

export const createHybridAuditTailState = (input: {
  readonly size: number;
  readonly identity?: HybridAuditFileIdentity | undefined;
  readonly continuityFingerprint?: string | undefined;
}): HybridAuditTailState => {
  const offset = Math.max(0, input.size - INITIAL_AUDIT_TAIL_BYTES);
  return {
    offset,
    remainder: "",
    identity: input.identity,
    initialBoundaryPending: offset > 0,
    initialBoundaryNeedsDrop: false,
    continuityFingerprint: input.continuityFingerprint,
  };
};

export const hybridAuditFileIdentityChanged = (
  previous: HybridAuditFileIdentity | undefined,
  next: HybridAuditFileIdentity | undefined,
): boolean =>
  previous !== undefined &&
  next !== undefined &&
  (previous.device !== next.device || previous.inode !== next.inode);

export const hybridAuditContinuityChanged = (
  previous: string | undefined,
  next: string | undefined,
): boolean => previous !== undefined && next !== undefined && previous !== next;

export const advanceHybridAuditTail = (
  state: HybridAuditTailState,
  chunk: HybridAuditTailChunk,
): HybridAuditTailAdvance => {
  const reset =
    hybridAuditFileIdentityChanged(state.identity, chunk.identity) || chunk.nextSize < state.offset;
  const continuityChanged = hybridAuditContinuityChanged(
    state.continuityFingerprint,
    chunk.continuityFingerprint,
  );
  const shouldReset = reset || continuityChanged;
  const combined = (shouldReset ? "" : state.remainder) + chunk.chunk;
  const lines = combined.split("\n");
  const remainder = lines.pop() ?? "";
  const initialBoundaryNeedsDrop =
    !shouldReset &&
    state.initialBoundaryPending &&
    (state.initialBoundaryNeedsDrop || chunk.precedingByte !== "\n");
  const hasCompleteInitialLine = lines.length > 0;
  const initialBoundaryPending =
    !shouldReset &&
    state.initialBoundaryPending &&
    initialBoundaryNeedsDrop &&
    !hasCompleteInitialLine;

  return {
    state: {
      offset: chunk.nextSize,
      remainder,
      identity: chunk.identity,
      initialBoundaryPending,
      initialBoundaryNeedsDrop: initialBoundaryPending,
      continuityFingerprint: chunk.nextContinuityFingerprint,
    },
    completeLines: initialBoundaryNeedsDrop ? lines.slice(1) : lines,
  };
};

const fileIdentityFromStat = (stat: unknown): HybridAuditFileIdentity | undefined => {
  if (!Predicate.isObject(stat) || !Predicate.isNumber(stat.dev) || !Predicate.isObject(stat.ino)) {
    return undefined;
  }
  if (stat.ino._tag !== "Some" || !Predicate.isNumber(stat.ino.value)) return undefined;
  return { device: String(stat.dev), inode: String(stat.ino.value) };
};

export const HybridRouteAuditServiceLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const auditPath = process.env.T3_HYBRID_ROUTER_AUDIT_LOG?.trim();
    if (!auditPath) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const limits = yield* ProviderLimitsService;
    const auditState = createHybridAuditState();

    const readRange = (offset: number, length: number) =>
      fs
        .stream(auditPath, { offset, bytesToRead: length })
        .pipe(Stream.decodeText(), Stream.mkString);
    const readFingerprint = (offset: number, length: number) =>
      fs.stream(auditPath, { offset, bytesToRead: length }).pipe(
        Stream.runFold<Uint8Array, Uint8Array>(
          () => new Uint8Array(),
          (previous, chunk) => {
            const combined = new Uint8Array(previous.byteLength + chunk.byteLength);
            combined.set(previous);
            combined.set(chunk, previous.byteLength);
            return combined;
          },
        ),
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );

    const stat = yield* fs.stat(auditPath).pipe(Effect.option);
    const size = stat._tag === "Some" ? Number(stat.value.size) : 0;
    const identity = stat._tag === "Some" ? fileIdentityFromStat(stat.value) : undefined;
    const initialOffset = Math.max(0, size - INITIAL_AUDIT_TAIL_BYTES);
    const initialFingerprint =
      stat._tag === "Some" && initialOffset > 0
        ? yield* readFingerprint(
            Math.max(0, initialOffset - CONTINUITY_FINGERPRINT_BYTES),
            Math.min(CONTINUITY_FINGERPRINT_BYTES, initialOffset),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined;
    const tailState = yield* Ref.make(
      createHybridAuditTailState({ size, identity, continuityFingerprint: initialFingerprint }),
    );

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
      const nextStat = yield* fs.stat(auditPath);
      const nextSize = Number(nextStat.size);
      const nextIdentity = fileIdentityFromStat(nextStat);
      const currentFingerprint =
        nextSize >= current.offset &&
        current.offset > 0 &&
        current.continuityFingerprint !== undefined
          ? yield* readFingerprint(
              Math.max(0, current.offset - CONTINUITY_FINGERPRINT_BYTES),
              Math.min(CONTINUITY_FINGERPRINT_BYTES, current.offset),
            )
          : undefined;
      const reset =
        hybridAuditFileIdentityChanged(current.identity, nextIdentity) ||
        nextSize < current.offset ||
        hybridAuditContinuityChanged(current.continuityFingerprint, currentFingerprint);
      const offset = reset ? 0 : current.offset;
      const length = nextSize - offset;
      if (length <= 0) return;
      const precedingByte =
        !reset && current.initialBoundaryPending && offset > 0
          ? yield* readRange(offset - 1, 1)
          : undefined;
      const appended = yield* readRange(offset, length);
      const nextFingerprint =
        nextSize > 0
          ? yield* readFingerprint(
              Math.max(0, nextSize - CONTINUITY_FINGERPRINT_BYTES),
              Math.min(CONTINUITY_FINGERPRINT_BYTES, nextSize),
            )
          : undefined;
      const advanced = advanceHybridAuditTail(current, {
        nextSize,
        identity: nextIdentity,
        chunk: appended,
        precedingByte,
        continuityFingerprint: currentFingerprint,
        nextContinuityFingerprint: nextFingerprint,
      });
      yield* Ref.set(tailState, advanced.state);
      yield* Effect.forEach(advanced.completeLines, ingestLine, { discard: true });
    }).pipe(Effect.ignoreCause({ log: true }));

    yield* readDelta;
    // Watch the directory so a missing or rotated audit file can reappear.
    yield* Stream.runForEach(fs.watch(path.dirname(auditPath)), () => readDelta).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  }),
);
