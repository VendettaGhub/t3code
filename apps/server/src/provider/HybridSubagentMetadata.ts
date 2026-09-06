import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { parse as parseYaml } from "yaml";

const MAX_AGENT_FILE_SIZE = FileSystem.Size(64 * 1024);
const FRONTMATTER_PATTERN = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface HybridSubagentMetadataInput {
  readonly subagentType?: unknown;
  readonly projectDir?: unknown;
  /** Resolved Claude user config root; agents live directly under `agents/`. */
  readonly configDir?: unknown;
  readonly bufferedModel?: unknown;
  readonly launchModel?: unknown;
  readonly launchEffort?: unknown;
  readonly parentModel?: unknown;
  readonly parentEffort?: unknown;
}

export interface HybridSubagentMetadata {
  readonly model?: string;
  readonly effort?: string;
}

interface AgentFrontmatter {
  readonly model?: string;
  readonly effort?: string;
}

const trimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const launchEffortString = (value: unknown): string | undefined => {
  const stringValue = trimmedString(value);
  if (stringValue !== undefined) return stringValue;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
};

export const normalizeHybridSubagentModel = (value: unknown): string | undefined => {
  const model = trimmedString(value);
  if (model === undefined) return undefined;
  const lowerModel = model.toLowerCase();
  if (lowerModel === "opus") return "claude-opus-5";
  if (lowerModel === "fable") return "claude-fable-5-1";
  if (
    model === "sonnet" ||
    /^claude-sonnet-5(?:-\d{8})?(?:\[|$)/iu.test(model) ||
    /^(?:anthropic\/)?gpt-5\.6-sol(?:\[|$)/iu.test(model)
  ) {
    return "gpt-5.6-sol";
  }
  if (
    model === "haiku" ||
    /^claude-haiku-4-5(?:-\d{8})?(?:\[|$)/iu.test(model) ||
    /^(?:anthropic\/)?gpt-5\.6-luna(?:\[|$)/iu.test(model)
  ) {
    return "gpt-5.6-luna";
  }
  if (/^(?:anthropic\/)?gpt-5\.3-codex-spark(?:\[|$)/iu.test(model)) {
    return "gpt-5.3-codex-spark";
  }
  return model;
};

const normalizeFrontmatterModel = (value: unknown): string | undefined => {
  const model = trimmedString(value);
  if (model === undefined || model.toLowerCase() === "inherit") return undefined;
  const aliases: Readonly<Record<string, string>> = {
    haiku: "claude-haiku-4-5",
    sonnet: "claude-sonnet-5",
    opus: "claude-opus-5",
    fable: "claude-fable-5-1",
  };
  return normalizeHybridSubagentModel(aliases[model.toLowerCase()] ?? model);
};

const parseFrontmatter = (contents: string): AgentFrontmatter | undefined => {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (!Predicate.isObject(parsed)) return undefined;

  const model = normalizeFrontmatterModel(parsed.model);
  const effort = trimmedString(parsed.effort)?.toLowerCase();
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort && VALID_EFFORTS.has(effort) ? { effort } : {}),
  };
};

const candidatePath = (
  path: Path.Path,
  root: string,
  directory: ReadonlyArray<string>,
  subagentType: string,
): string | undefined => {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...directory, `${subagentType}.md`);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return candidate;
};

const readAgentFrontmatter = Effect.fn("readAgentFrontmatter")(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.fn.Return<AgentFrontmatter | undefined, never> {
  const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || info.value.size > MAX_AGENT_FILE_SIZE) {
    return undefined;
  }
  const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
  return Option.isSome(contents) ? parseFrontmatter(contents.value) : undefined;
});

/**
 * Resolve the display metadata carried by a Claude subagent task.
 *
 * The adapter supplies its already-buffered runtime model and launch inputs;
 * this helper only reads the explicitly supplied project/config roots and never
 * discovers arbitrary user paths on its own.
 */
export const resolveHybridSubagentMetadata = Effect.fn("resolveHybridSubagentMetadata")(function* (
  input: HybridSubagentMetadataInput,
): Effect.fn.Return<HybridSubagentMetadata, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bufferedModel = normalizeHybridSubagentModel(input.bufferedModel);
  const launchModel = normalizeHybridSubagentModel(input.launchModel);
  const parentModel = normalizeHybridSubagentModel(input.parentModel);
  const launchEffort = launchEffortString(input.launchEffort);
  const parentEffort = trimmedString(input.parentEffort);
  const fallbackModel = bufferedModel ?? launchModel ?? parentModel;
  const fallbackEffort = launchEffort ?? parentEffort;
  const fallback: HybridSubagentMetadata = {
    ...(fallbackModel !== undefined ? { model: fallbackModel } : {}),
    ...(fallbackEffort !== undefined ? { effort: fallbackEffort } : {}),
  };

  const subagentType = trimmedString(input.subagentType);
  if (subagentType === undefined || !/^[A-Za-z0-9_-]+$/u.test(subagentType)) {
    return fallback;
  }

  const roots = [
    { root: trimmedString(input.projectDir), directory: [".claude", "agents"] },
    { root: trimmedString(input.configDir), directory: ["agents"] },
  ];
  let frontmatter: AgentFrontmatter | undefined;
  for (const candidate of roots) {
    if (candidate.root === undefined) continue;
    const filePath = candidatePath(path, candidate.root, candidate.directory, subagentType);
    if (filePath === undefined) continue;
    frontmatter = yield* readAgentFrontmatter(fileSystem, filePath);
    if (frontmatter !== undefined) break;
  }

  const model = bufferedModel ?? launchModel ?? frontmatter?.model ?? parentModel;
  const effort = launchEffort ?? frontmatter?.effort ?? parentEffort;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
});
