import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  normalizeHybridSubagentModel,
  resolveHybridSubagentMetadata,
} from "./HybridSubagentMetadata.ts";

it("normalizes dated carriers consistently for early and late runtime snapshots", () => {
  assert.equal(normalizeHybridSubagentModel("claude-haiku-4-5-20251001"), "gpt-5.6-luna");
  assert.equal(normalizeHybridSubagentModel("claude-sonnet-5-20260801[1m]"), "gpt-5.6-sol");
  assert.equal(
    normalizeHybridSubagentModel("claude-sonnet-4-6-20251117"),
    "claude-sonnet-4-6-20251117",
  );
});

const writeAgent = Effect.fn(function* (root: string, name: string, frontmatter: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, ".claude", "agents");
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, `${name}.md`),
    `---\n${frontmatter}\n---\n\nAgent instructions.\n`,
  );
});

const writeConfigAgent = Effect.fn(function* (
  configDir: string,
  name: string,
  frontmatter: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(configDir, "agents");
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, `${name}.md`),
    `---\n${frontmatter}\n---\n\nAgent instructions.\n`,
  );
});

it.layer(NodeServices.layer)("resolveHybridSubagentMetadata", (it) => {
  it.effect("prefers a buffered model and an explicit launch effort", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-subagent-metadata-",
      });
      yield* writeAgent(tempDirectory, "worker", "model: haiku\neffort: high");

      const metadata = yield* resolveHybridSubagentMetadata({
        subagentType: "worker",
        projectDir: tempDirectory,
        bufferedModel: "anthropic/gpt-5.3-codex-spark[xhigh]",
        launchModel: "sonnet",
        launchEffort: 7,
        parentModel: "parent-model",
        parentEffort: "medium",
      });

      assert.deepEqual(metadata, { model: "gpt-5.3-codex-spark", effort: "7" });

      const launchMetadata = yield* resolveHybridSubagentMetadata({
        subagentType: "worker",
        projectDir: tempDirectory,
        launchModel: "haiku",
        parentModel: "parent-model",
        parentEffort: "medium",
      });
      assert.deepEqual(launchMetadata, { model: "gpt-5.6-luna", effort: "high" });

      for (const [launchModel, expectedModel] of [
        ["opus", "claude-opus-5"],
        ["fable", "claude-fable-5-1"],
      ] as const) {
        const aliasMetadata = yield* resolveHybridSubagentMetadata({
          subagentType: "worker",
          projectDir: tempDirectory,
          launchModel,
          parentModel: "parent-model",
        });
        assert.equal(aliasMetadata.model, expectedModel);
      }
    }),
  );

  it.effect("uses project agents before home agents and normalizes aliases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-subagent-metadata-",
      });
      const projectDirectory = path.join(tempDirectory, "project");
      const configDirectory = path.join(tempDirectory, "claude-config");
      yield* writeAgent(projectDirectory, "worker", "model: sonnet\neffort: xhigh");
      yield* writeConfigAgent(configDirectory, "worker", "model: fable\neffort: low");

      const projectMetadata = yield* resolveHybridSubagentMetadata({
        subagentType: "worker",
        projectDir: projectDirectory,
        configDir: configDirectory,
        parentModel: "parent-model",
        parentEffort: "medium",
      });
      assert.deepEqual(projectMetadata, { model: "gpt-5.6-sol", effort: "xhigh" });

      yield* fileSystem.remove(path.join(projectDirectory, ".claude"), { recursive: true });
      const configMetadata = yield* resolveHybridSubagentMetadata({
        subagentType: "worker",
        projectDir: projectDirectory,
        configDir: configDirectory,
        parentModel: "parent-model",
        parentEffort: "medium",
      });
      assert.deepEqual(configMetadata, { model: "claude-fable-5-1", effort: "low" });
    }),
  );

  it.effect("treats inherit and unsupported frontmatter as parent fallbacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-subagent-metadata-",
      });
      yield* writeAgent(tempDirectory, "worker", "model: inherit\neffort: ultrathink");

      const metadata = yield* resolveHybridSubagentMetadata({
        subagentType: "worker",
        projectDir: tempDirectory,
        parentModel: "parent-model",
        parentEffort: "medium",
      });

      assert.deepEqual(metadata, { model: "parent-model", effort: "medium" });
    }),
  );

  it.effect("ignores unsafe or oversized agent files without escaping the configured roots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-subagent-metadata-",
      });
      const escapedPath = path.join(tempDirectory, "evil.md");
      yield* fileSystem.writeFileString(escapedPath, "---\nmodel: sonnet\n---\n");
      const agentsRoot = path.join(tempDirectory, ".claude", "agents");
      yield* fileSystem.makeDirectory(agentsRoot, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(agentsRoot, "large.md"),
        `---\nmodel: sonnet\n---\n${"x".repeat(65 * 1024)}\n`,
      );

      const traversalMetadata = yield* resolveHybridSubagentMetadata({
        subagentType: "../evil",
        projectDir: tempDirectory,
        parentModel: "parent-model",
        parentEffort: "medium",
      });
      assert.deepEqual(traversalMetadata, { model: "parent-model", effort: "medium" });

      const oversizedMetadata = yield* resolveHybridSubagentMetadata({
        subagentType: "large",
        projectDir: tempDirectory,
        parentModel: "parent-model",
        parentEffort: "medium",
      });
      assert.deepEqual(oversizedMetadata, { model: "parent-model", effort: "medium" });
    }),
  );
});
