import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

import type { ClaudeCatalogModel, ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";

export const isHybridModelEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
) => environment.CLAUDE_BACKEND === "hybrid" && Boolean(environment.ANTHROPIC_BASE_URL?.trim());

const FABLE_MODEL = "claude-fable-5-1";
const OPUS_MODEL = "claude-opus-5";
const SOL_MODEL = "claude-sonnet-5";
const LUNA_MODEL = "claude-haiku-4-5";
const ASTRA_MODEL = "gpt-6-astra";
const QWEN_MODEL = "qwen3.8-27b";

const DEFAULT_CONTEXT_WINDOW = 272_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;
const NINE_HUNDRED_K_CONTEXT_WINDOW = 900_000;
const QWEN_CONTEXT_WINDOW = 131_072;

const DEFAULT_AUTO_COMPACT_WINDOW = 240_000;
const EXTENDED_AUTO_COMPACT_WINDOW = 900_000;
const NINE_HUNDRED_K_AUTO_COMPACT_WINDOW = 850_000;
const QWEN_AUTO_COMPACT_WINDOW = 95_000;

const HYBRID_CARRIER_MODELS = new Set([FABLE_MODEL, OPUS_MODEL, SOL_MODEL, LUNA_MODEL]);

const EFFORT_POLICIES: Readonly<
  Record<string, { readonly values: ReadonlyArray<string>; readonly defaultValue: string }>
> = {
  [FABLE_MODEL]: { values: ["low", "medium", "high"], defaultValue: "medium" },
  [OPUS_MODEL]: { values: ["low", "medium", "high"], defaultValue: "medium" },
  [SOL_MODEL]: { values: ["low", "medium", "high", "xhigh"], defaultValue: "medium" },
  [LUNA_MODEL]: { values: ["xhigh", "max"], defaultValue: "xhigh" },
  [ASTRA_MODEL]: {
    values: ["low", "medium", "high", "xhigh", "max"],
    defaultValue: "medium",
  },
  [QWEN_MODEL]: { values: ["low", "medium", "xhigh"], defaultValue: "xhigh" },
};

const effortOption = (
  values: ReadonlyArray<string>,
  defaultValue: string,
): ProviderOptionDescriptor => ({
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: values.map((id) => ({
    id,
    label: id === "xhigh" ? "Extra High" : id.charAt(0).toUpperCase() + id.slice(1),
    ...(id === defaultValue ? { isDefault: true } : {}),
  })),
});

const selectOption = (
  id: string,
  label: string,
  options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly isDefault?: boolean;
  }>,
): ProviderOptionDescriptor => ({
  id,
  label,
  type: "select",
  options: options.map((option) => ({ ...option })),
});

const booleanOption = (id: string, label: string): ProviderOptionDescriptor => ({
  id,
  label,
  type: "boolean",
});

const carrierContextOption = () =>
  selectOption("contextWindow", "Context Window", [
    { id: "default", label: "272k", isDefault: true },
    { id: "900k", label: "900k (higher usage)" },
    { id: "1m", label: "1M" },
  ]);

const carrierContextWindowTokens = {
  default: DEFAULT_CONTEXT_WINDOW,
  "900k": NINE_HUNDRED_K_CONTEXT_WINDOW,
  "1m": EXTENDED_CONTEXT_WINDOW,
};

const carrierNames: Readonly<Record<string, string>> = {
  [FABLE_MODEL]: "Claude Fable 5.1",
  [OPUS_MODEL]: "Claude Opus 5",
  [SOL_MODEL]: "GPT-5.6 Sol",
  [LUNA_MODEL]: "GPT-5.6 Luna",
};

function carrierCapabilities(model: string): ModelCapabilities {
  const effortPolicy = EFFORT_POLICIES[model];
  if (!effortPolicy) throw new Error(`Missing hybrid effort policy for ${model}`);
  const effort = effortOption(effortPolicy.values, effortPolicy.defaultValue);
  const optionDescriptors = [effort];
  if (model === SOL_MODEL || model === LUNA_MODEL) {
    optionDescriptors.push(booleanOption("fastMode", "Fast Mode"));
  }
  optionDescriptors.push(carrierContextOption());
  return { optionDescriptors };
}

function astraCapabilities(): ModelCapabilities {
  const effortPolicy = EFFORT_POLICIES[ASTRA_MODEL];
  if (!effortPolicy) throw new Error(`Missing hybrid effort policy for ${ASTRA_MODEL}`);
  return {
    optionDescriptors: [
      effortOption(effortPolicy.values, effortPolicy.defaultValue),
      selectOption("serviceTier", "Service Tier", [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Priority (higher usage)" },
      ]),
      selectOption("contextWindow", "Context Window", [
        { id: "272k", label: "272k", isDefault: true },
        { id: "900k", label: "900k (higher usage)" },
      ]),
    ],
  };
}

function qwenCapabilities(): ModelCapabilities {
  const effortPolicy = EFFORT_POLICIES[QWEN_MODEL];
  if (!effortPolicy) throw new Error(`Missing hybrid effort policy for ${QWEN_MODEL}`);
  return {
    optionDescriptors: [
      effortOption(effortPolicy.values, effortPolicy.defaultValue),
      selectOption("contextWindow", "Context Window", [
        { id: "131k", label: "131k", isDefault: true },
      ]),
    ],
  };
}

function capabilitiesForHybridModel(model: string): ModelCapabilities {
  if (HYBRID_CARRIER_MODELS.has(model)) return carrierCapabilities(model);
  if (model === ASTRA_MODEL) return astraCapabilities();
  if (model === QWEN_MODEL) return qwenCapabilities();
  throw new Error(`Missing hybrid capabilities for ${model}`);
}

function withoutFixedContextWindow(
  runtime: ClaudeCatalogModel["runtime"],
): ClaudeCatalogModel["runtime"] {
  const { fixedContextWindowTokens: _fixedContextWindowTokens, ...rest } = runtime;
  return rest;
}

function overlayCarrier(entry: ClaudeCatalogModel): ClaudeCatalogModel {
  const model = entry.model.slug;
  return {
    ...entry,
    model: {
      ...entry.model,
      name: carrierNames[model] ?? entry.model.name,
      ...(model === SOL_MODEL || model === LUNA_MODEL ? { isCustom: true, isLegacy: false } : {}),
      capabilities: carrierCapabilities(model),
    },
    runtime: {
      ...withoutFixedContextWindow(entry.runtime),
      contextWindowTokens: { ...carrierContextWindowTokens },
    },
  };
}

function upsertHybridModel(
  models: ReadonlyArray<ClaudeCatalogModel>,
  slug: string,
  name: string,
  capabilities: ModelCapabilities,
  runtime: ClaudeCatalogModel["runtime"],
): Array<ClaudeCatalogModel> {
  const index = models.findIndex((entry) => entry.model.slug === slug);
  const existing = index >= 0 ? models[index] : undefined;
  if (!existing) {
    return [
      ...models,
      {
        model: { slug, name, isCustom: true, capabilities },
        runtime,
        compatibility: {},
      },
    ];
  }
  const result = [...models];
  result[index] = {
    ...existing,
    model: { ...existing.model, name, capabilities },
    runtime: { ...withoutFixedContextWindow(existing.runtime), ...runtime },
  };
  return result;
}

/**
 * Applies the local hybrid picker policy without mutating the provider
 * catalog. Native models not listed here retain their model and compatibility
 * metadata verbatim.
 */
export function withHybridModelCatalog(catalog: ClaudeModelCatalog): ClaudeModelCatalog {
  if (!catalog.models.some((entry) => HYBRID_CARRIER_MODELS.has(entry.model.slug))) {
    return catalog;
  }

  let models = catalog.models.map((entry) =>
    HYBRID_CARRIER_MODELS.has(entry.model.slug) ? overlayCarrier(entry) : entry,
  );

  models = upsertHybridModel(models, ASTRA_MODEL, "GPT-6 Astra", astraCapabilities(), {
    contextWindowTokens: {
      "272k": DEFAULT_CONTEXT_WINDOW,
      "900k": NINE_HUNDRED_K_CONTEXT_WINDOW,
    },
  });
  models = upsertHybridModel(models, QWEN_MODEL, "Qwen 3.8 27B (VPN, 131k)", qwenCapabilities(), {
    fixedContextWindowTokens: QWEN_CONTEXT_WINDOW,
  });

  return { ...catalog, models, hybrid: true };
}

export interface HybridQueryPolicy {
  readonly contextWindow: number;
  readonly autoCompactWindow: number;
  readonly apiModelId?: string;
}

function validEffort(selection: ModelSelection, model: string): string {
  const policy = EFFORT_POLICIES[model];
  if (!policy) throw new Error(`Missing hybrid effort policy for ${model}`);
  const descriptor = getProviderOptionDescriptors({
    caps: capabilitiesForHybridModel(model),
    selections: selection.options,
  }).find((candidate) => candidate.id === "effort");
  const effort = getProviderOptionCurrentValue(descriptor);
  return typeof effort === "string" && policy.values.includes(effort)
    ? effort
    : policy.defaultValue;
}

function carrierApiModelId(selection: ModelSelection, effort: string): string | undefined {
  const model = selection.model;
  if (!HYBRID_CARRIER_MODELS.has(model)) return undefined;
  const fast = getModelSelectionBooleanOptionValue(selection, "fastMode") === true;
  return `${model}[1m][effort=${effort}]${fast ? "[fast=true]" : ""}`;
}

/** Resolves hybrid context, compaction, and provider-carrier settings only. */
export function resolveHybridQueryPolicy(selection: ModelSelection): HybridQueryPolicy | undefined {
  const model = selection.model;
  if (!HYBRID_CARRIER_MODELS.has(model) && model !== ASTRA_MODEL && model !== QWEN_MODEL) {
    return undefined;
  }

  if (model === QWEN_MODEL) {
    return {
      contextWindow: QWEN_CONTEXT_WINDOW,
      autoCompactWindow: QWEN_AUTO_COMPACT_WINDOW,
      apiModelId: `${model}[effort=${validEffort(selection, model)}]`,
    };
  }

  const effort = validEffort(selection, model);
  const context = getModelSelectionStringOptionValue(selection, "contextWindow");
  if (model === ASTRA_MODEL) {
    const extended = context === "900k";
    const priority = getModelSelectionStringOptionValue(selection, "serviceTier") === "priority";
    return {
      contextWindow: extended ? NINE_HUNDRED_K_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW,
      autoCompactWindow: extended
        ? NINE_HUNDRED_K_AUTO_COMPACT_WINDOW
        : DEFAULT_AUTO_COMPACT_WINDOW,
      apiModelId: `${model}[effort=${effort}]${priority ? "[fast=true]" : ""}`,
    };
  }

  const extended = context === "1m";
  const nineHundredK = context === "900k";
  const basePolicy = {
    contextWindow: extended
      ? EXTENDED_CONTEXT_WINDOW
      : nineHundredK
        ? NINE_HUNDRED_K_CONTEXT_WINDOW
        : DEFAULT_CONTEXT_WINDOW,
    autoCompactWindow: extended
      ? EXTENDED_AUTO_COMPACT_WINDOW
      : nineHundredK
        ? NINE_HUNDRED_K_AUTO_COMPACT_WINDOW
        : DEFAULT_AUTO_COMPACT_WINDOW,
  } satisfies HybridQueryPolicy;
  const apiModelId = carrierApiModelId(selection, effort);
  return apiModelId ? { ...basePolicy, apiModelId } : basePolicy;
}
