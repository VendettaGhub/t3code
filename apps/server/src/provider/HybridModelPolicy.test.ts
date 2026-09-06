import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogApiModelId,
  resolveClaudeModelCatalog,
  scopeClaudeModelCatalog,
  type ClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";
import {
  isHybridModelEnvironment,
  resolveHybridQueryPolicy,
  withHybridModelCatalog,
} from "./HybridModelPolicy.ts";
import { BUNDLED_MODEL_MANIFEST, classifyModels } from "./ModelManifest.ts";

const instanceId = ProviderInstanceId.make("claude");

it("preserves hybrid policy when custom aliases are scoped out", () => {
  const hybrid = withHybridModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG);
  const scoped = scopeClaudeModelCatalog(hybrid, ["sonnet"]);
  expect(scoped.hybrid).toBe(true);
  expect(scoped.models.some((entry) => entry.model.aliases?.includes("sonnet"))).toBe(false);
  const model = createModelSelection(instanceId, "claude-sonnet-5");
  expect(resolveClaudeCatalogApiModelId(scoped, model)).toBe("claude-sonnet-5[1m][effort=medium]");
  expect(resolveClaudeCatalogContextWindowTokens(scoped, model)).toBe(272_000);
});

it("leaves native Claude untouched unless its environment explicitly enables hybrid routing", () => {
  expect(isHybridModelEnvironment({})).toBe(false);
  expect(isHybridModelEnvironment({ ANTHROPIC_BASE_URL: "http://localhost:1234" })).toBe(false);
  expect(isHybridModelEnvironment({ CLAUDE_BACKEND: "hybrid" })).toBe(false);
  expect(
    isHybridModelEnvironment({
      CLAUDE_BACKEND: "hybrid",
      ANTHROPIC_BASE_URL: "http://localhost:1234",
    }),
  ).toBe(true);
  const native = resolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST);
  const hybrid = resolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST, true);
  const model = createModelSelection(instanceId, "claude-sonnet-5");
  expect(resolveClaudeCatalogApiModelId(native, model)).toBe("claude-sonnet-5");
  expect(resolveClaudeCatalogApiModelId(hybrid, model)).toBe("claude-sonnet-5[1m][effort=medium]");
  const classified = classifyModels(
    hybrid.models.map((entry) => entry.model),
    BUNDLED_MODEL_MANIFEST,
    ProviderDriverKind.make("claudeAgent"),
  );
  expect(classified.find((entry) => entry.slug === "claude-haiku-4-5")).toMatchObject({
    name: "GPT-5.6 Luna",
    isLegacy: false,
  });
});
const selection = (
  model: string,
  options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>,
) => createModelSelection(instanceId, model, options);

const descriptor = (model: ClaudeModelCatalog["models"][number], id: string) =>
  model.model.capabilities?.optionDescriptors?.find((option) => option.id === id);

const baseCatalog = (): ClaudeModelCatalog => ({
  models: [
    {
      model: {
        slug: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        isCustom: false,
        capabilities: null,
      },
      runtime: { modelSuffixes: { contextWindow: { "1m": "[1m]" } } },
      compatibility: { minVersion: "2.1.257" },
    },
    {
      model: {
        slug: "claude-opus-5",
        name: "Claude Opus 5",
        isCustom: false,
        capabilities: null,
      },
      runtime: { modelSuffixes: { contextWindow: { "1m": "[1m]" } } },
      compatibility: { minVersion: "2.1.219" },
    },
    {
      model: {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        isCustom: false,
        capabilities: null,
      },
      runtime: { modelSuffixes: { contextWindow: { "1m": "[1m]" } } },
      compatibility: {},
    },
    {
      model: {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: null,
      },
      runtime: {},
      compatibility: {},
    },
    {
      model: {
        slug: "native-model",
        name: "Native model",
        isCustom: false,
        capabilities: null,
      },
      runtime: { fixedContextWindowTokens: 42_000 },
      compatibility: { maxVersionExclusive: "3.0.0" },
    },
  ],
});

it("overlays the four carrier models, preserves native entries, and adds Astra and Qwen", () => {
  const catalog = baseCatalog();
  const native = catalog.models[4];
  const result = withHybridModelCatalog(catalog);

  expect(result).not.toBe(catalog);
  expect(result.models).toHaveLength(7);
  expect(result.models.find((entry) => entry.model.slug === "native-model")).toBe(native);

  const fable = result.models.find((entry) => entry.model.slug === "claude-fable-5-1");
  expect(fable?.model.name).toBe("Claude Fable 5.1");
  expect(fable?.runtime.modelSuffixes).toEqual({ contextWindow: { "1m": "[1m]" } });
  expect(fable?.compatibility).toEqual({ minVersion: "2.1.257" });
  expect(descriptor(fable!, "effort")).toMatchObject({
    type: "select",
    options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }],
  });

  const sol = result.models.find((entry) => entry.model.slug === "claude-sonnet-5");
  expect(descriptor(sol!, "fastMode")).toMatchObject({ type: "boolean" });
  expect(descriptor(sol!, "contextWindow")).toMatchObject({
    options: [{ id: "default", isDefault: true }, { id: "900k" }, { id: "1m" }],
  });

  const astra = result.models.find((entry) => entry.model.slug === "gpt-6-astra");
  expect(astra?.model).toMatchObject({ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: true });
  expect(astra?.runtime.contextWindowTokens).toEqual({ "272k": 272_000, "900k": 900_000 });
  expect(descriptor(astra!, "serviceTier")).toMatchObject({
    options: [{ id: "default", isDefault: true }, { id: "priority" }],
  });

  const qwen = result.models.find((entry) => entry.model.slug === "qwen3.8-27b");
  expect(qwen?.model).toMatchObject({
    slug: "qwen3.8-27b",
    name: "Qwen 3.8 27B (VPN, 131k)",
    isCustom: true,
  });
  expect(qwen?.runtime.fixedContextWindowTokens).toBe(131_072);
  expect(descriptor(qwen!, "effort")).toMatchObject({
    options: [{ id: "low" }, { id: "medium" }, { id: "xhigh", isDefault: true }],
  });
});

it("does not add hybrid models to an unrelated native catalog", () => {
  const catalog: ClaudeModelCatalog = {
    models: [
      {
        model: {
          slug: "native-only",
          name: "Native only",
          isCustom: false,
          capabilities: null,
        },
        runtime: {},
        compatibility: {},
      },
    ],
  };

  expect(withHybridModelCatalog(catalog)).toBe(catalog);
});

it("resolves policy defaults and validated options for every hybrid model", () => {
  const cases = [
    [
      "Qwen default",
      selection("qwen3.8-27b"),
      {
        contextWindow: 131_072,
        autoCompactWindow: 95_000,
        apiModelId: "qwen3.8-27b[effort=xhigh]",
      },
    ],
    [
      "Qwen invalid effort",
      selection("qwen3.8-27b", [{ id: "effort", value: "max" }]),
      {
        contextWindow: 131_072,
        autoCompactWindow: 95_000,
        apiModelId: "qwen3.8-27b[effort=xhigh]",
      },
    ],
    [
      "Astra default",
      selection("gpt-6-astra"),
      {
        contextWindow: 272_000,
        autoCompactWindow: 240_000,
        apiModelId: "gpt-6-astra[effort=medium]",
      },
    ],
    [
      "Astra 900k priority",
      selection("gpt-6-astra", [
        { id: "contextWindow", value: "900k" },
        { id: "serviceTier", value: "priority" },
        { id: "effort", value: "max" },
      ]),
      {
        contextWindow: 900_000,
        autoCompactWindow: 850_000,
        apiModelId: "gpt-6-astra[effort=max][fast=true]",
      },
    ],
    [
      "Sol fast xhigh",
      selection("claude-sonnet-5", [
        { id: "contextWindow", value: "900k" },
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: true },
      ]),
      {
        contextWindow: 900_000,
        autoCompactWindow: 850_000,
        apiModelId: "claude-sonnet-5[1m][effort=xhigh][fast=true]",
      },
    ],
    [
      "Luna invalid effort",
      selection("claude-haiku-4-5", [{ id: "effort", value: "medium" }]),
      {
        contextWindow: 272_000,
        autoCompactWindow: 240_000,
        apiModelId: "claude-haiku-4-5[1m][effort=xhigh]",
      },
    ],
    [
      "Opus native 1m suffix",
      selection("claude-opus-5", [{ id: "contextWindow", value: "1m" }]),
      {
        contextWindow: 1_000_000,
        autoCompactWindow: 900_000,
        apiModelId: "claude-opus-5[1m][effort=medium]",
      },
    ],
    [
      "Fable default",
      selection("claude-fable-5-1"),
      {
        contextWindow: 272_000,
        autoCompactWindow: 240_000,
        apiModelId: "claude-fable-5-1[1m][effort=medium]",
      },
    ],
  ] as const;

  for (const [name, modelSelection, expected] of cases) {
    expect(resolveHybridQueryPolicy(modelSelection), name).toEqual(expected);
  }
});

it("lets the hybrid context map outrank fixed upstream metadata in the real bundled catalog", () => {
  const carrierSlugs = new Set([
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ]);
  const catalogWithFixedProfiles: ClaudeModelCatalog = {
    models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) =>
      carrierSlugs.has(entry.model.slug)
        ? { ...entry, runtime: { ...entry.runtime, fixedContextWindowTokens: 1_000_000 } }
        : entry,
    ),
  };
  const hybrid = withHybridModelCatalog(catalogWithFixedProfiles);

  for (const model of carrierSlugs) {
    expect(resolveClaudeCatalogContextWindowTokens(hybrid, selection(model)), model).toBe(272_000);
    expect(hybrid.models.find((entry) => entry.model.slug === model)?.runtime).not.toHaveProperty(
      "fixedContextWindowTokens",
    );
  }
});

it("returns no policy for unrelated models and does not retain state across switching", () => {
  const environment = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "260000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "260000",
  };
  const qwen = resolveHybridQueryPolicy(selection("qwen3.8-27b"));
  const astra = resolveHybridQueryPolicy(selection("gpt-6-astra"));
  const native = resolveHybridQueryPolicy(selection("native-model"));

  expect(native).toBeUndefined();
  expect(qwen).toEqual({
    contextWindow: 131_072,
    autoCompactWindow: 95_000,
    apiModelId: "qwen3.8-27b[effort=xhigh]",
  });
  expect(astra).toEqual({
    contextWindow: 272_000,
    autoCompactWindow: 240_000,
    apiModelId: "gpt-6-astra[effort=medium]",
  });
  expect(environment).toEqual({
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "260000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "260000",
  });
});
