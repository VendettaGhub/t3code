// @effect-diagnostics nodeBuiltinImport:off - Exercises native no-replace publication and Windows junction rejection.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
const { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } = NodeFSP;
const { tmpdir } = NodeOS;
const { join } = NodePath;
import { stageClaudeForkFile } from "./claudeForkFile.js";

const roots: string[] = [];
const sessionId = "00000000-0000-4000-8000-000000000123";
const bytes = Buffer.from('{"type":"user","message":{"content":"invented"}}\n');
async function setup() {
  const configDir = await mkdtemp(join(tmpdir(), "t3-fork-file-test-"));
  roots.push(configDir);
  const project = join(configDir, "projects", "fixture");
  await mkdir(project, { recursive: true });
  return { configDir, project };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("parent-owned Claude fork publication", () => {
  it("publishes exact bytes and discards only its own file", async () => {
    const { configDir, project } = await setup();
    const lease = await stageClaudeForkFile(configDir, "fixture", sessionId, bytes);
    expect(await readdir(project)).not.toContain(`${sessionId}.jsonl`);
    await lease.publish();
    expect(await readFile(join(project, `${sessionId}.jsonl`))).toEqual(bytes);
    await lease.discard();
    expect(await readdir(project)).toEqual([]);
  });
  it("never replaces an existing target", async () => {
    const { configDir, project } = await setup();
    const existing = Buffer.from("existing-session");
    await writeFile(join(project, `${sessionId}.jsonl`), existing);
    const lease = await stageClaudeForkFile(configDir, "fixture", sessionId, bytes);
    await expect(lease.publish()).rejects.toThrow();
    await lease.discard();
    expect(await readFile(join(project, `${sessionId}.jsonl`))).toEqual(existing);
  });
  it.each(["..", "../escape", "a/b", "a\\b", "C:\\escape", ".", "fixture."])(
    "rejects project segment %s",
    async (key) => {
      const { configDir } = await setup();
      await expect(stageClaudeForkFile(configDir, key, sessionId, bytes)).rejects.toThrow(
        "project key",
      );
    },
  );
  it("rejects a junction/reparse path outside the selected home", async () => {
    const { configDir } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "t3-fork-outside-test-"));
    roots.push(outside);
    await symlink(outside, join(configDir, "projects", "escape"), "junction");
    await expect(stageClaudeForkFile(configDir, "escape", sessionId, bytes)).rejects.toThrow(
      "symbolic",
    );
    expect(await readdir(outside)).toEqual([]);
  });
  it("cleans stage on abort before publication", async () => {
    const { configDir, project } = await setup();
    const lease = await stageClaudeForkFile(configDir, "fixture", sessionId, bytes);
    await expect(lease.publish(AbortSignal.abort())).rejects.toThrow();
    await lease.discard();
    expect(await readdir(project)).toEqual([]);
  });
  it("cleans its target when cancellation arrives immediately after the link", async () => {
    const { configDir, project } = await setup();
    const lease = await stageClaudeForkFile(configDir, "fixture", sessionId, bytes);
    const controller = new AbortController();
    let checks = 0;
    // The third checkpoint is after the real no-replace link, before verification.
    controller.signal.throwIfAborted = () => {
      if (++checks === 3) controller.abort();
      AbortSignal.prototype.throwIfAborted.call(controller.signal);
    };
    await expect(lease.publish(controller.signal)).rejects.toThrow();
    expect(await readFile(join(project, `${sessionId}.jsonl`))).toEqual(bytes);
    await lease.discard();
    expect(await readdir(project)).toEqual([]);
  });
  it("refuses cleanup if the published file changed", async () => {
    const { configDir, project } = await setup();
    const lease = await stageClaudeForkFile(configDir, "fixture", sessionId, bytes);
    await lease.publish();
    await writeFile(join(project, `${sessionId}.jsonl`), "changed-session");
    await expect(lease.discard()).rejects.toThrow("changed");
    expect(await readFile(join(project, `${sessionId}.jsonl`), "utf8")).toBe("changed-session");
  });
});
