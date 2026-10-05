// @effect-diagnostics nodeBuiltinImport:off - Ownership checks require lstat; Effect FileSystem.stat follows links.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const { createHash } = NodeCrypto;
const { constants } = NodeFS;
type BigIntStats = NodeFS.BigIntStats;
const { link, lstat, mkdtemp, open, readFile, rmdir, unlink } = NodeFSP;
const { isAbsolute, join, parse, relative, resolve, sep } = NodePath;

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const absent = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

async function assertNoLinks(directory: string): Promise<void> {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error("Claude fork path contains a symbolic link or reparse point.");
    if (!stat.isDirectory()) throw new Error("Claude fork path is not a directory.");
  }
}

// Caller must register discard before publish and retain ownership until thread.create commits.
// Process crashes can orphan a publication; there is deliberately no session GC/recovery here.
export async function stageClaudeForkFile(
  configDir: string,
  projectKey: string,
  sessionId: string,
  bytes: Uint8Array,
) {
  if (!isAbsolute(configDir))
    throw new Error("Explicit absolute Claude config directory is required.");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectKey)) throw new Error("Invalid Claude fork project key.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error("Invalid Claude fork target session id.");
  }
  const project = join(configDir, "projects", projectKey);
  await assertNoLinks(project);
  const expectedBytes = bytes.byteLength;
  const expectedHash = digest(bytes);
  const stageDirectory = await mkdtemp(join(project, ".t3-fork-"));
  const stage = join(stageDirectory, "transcript");
  const target = join(project, `${sessionId}.jsonl`);
  let published = false;
  let discarded = false;
  let identity: BigIntStats;
  try {
    const file = await open(stage, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const staged = await readFile(stage);
    if (staged.byteLength !== expectedBytes || digest(staged) !== expectedHash) {
      throw new Error("Claude fork staging integrity check failed.");
    }
    identity = await lstat(stage, { bigint: true });
    if (identity.ino === 0n) throw new Error("Claude fork file identity is unavailable.");
  } catch (error) {
    await unlink(stage).catch((failure: unknown) => {
      if (!absent(failure)) throw failure;
    });
    await rmdir(stageDirectory);
    throw error;
  }
  const assertIdentity = (stat: BigIntStats) => {
    if (
      !stat.isFile() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.size !== BigInt(expectedBytes)
    ) {
      throw new Error("Claude fork file changed; refusing cleanup/publication.");
    }
  };
  const assertOwnFile = async (path: string) => {
    assertIdentity(await lstat(path, { bigint: true }));
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      assertIdentity(await file.stat({ bigint: true }));
      const actual = Buffer.alloc(expectedBytes + 1);
      let count = 0;
      while (count < actual.byteLength) {
        const result = await file.read(actual, count, actual.byteLength - count, count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (count !== expectedBytes || digest(actual.subarray(0, count)) !== expectedHash) {
        throw new Error("Claude fork file changed; refusing cleanup/publication.");
      }
      assertIdentity(await lstat(path, { bigint: true }));
    } finally {
      await file.close();
    }
  };
  return {
    sessionId,
    bytes: expectedBytes,
    sha256: expectedHash,
    publish: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (published || discarded)
        throw new Error("Claude fork publication is no longer available.");
      await assertNoLinks(stageDirectory);
      await assertOwnFile(stage);
      signal?.throwIfAborted();
      // link is atomic and fails on an existing destination, unlike rename.
      await link(stage, target);
      published = true;
      signal?.throwIfAborted();
      await assertOwnFile(target);
      await unlink(stage);
      await rmdir(stageDirectory);
    },
    discard: async () => {
      if (discarded) return;
      await assertNoLinks(project);
      if (published) {
        await assertOwnFile(target);
        await unlink(target);
        published = false;
      }
      try {
        await assertNoLinks(stageDirectory);
        await assertOwnFile(stage);
        await unlink(stage);
        await rmdir(stageDirectory);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      discarded = true;
    },
  };
}
