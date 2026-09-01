const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_RESOURCES = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Programs",
  "t3code",
  "resources",
);

const DEFAULT_BUNDLE = path.join(
  DEFAULT_RESOURCES,
  "app.asar.unpacked",
  "apps",
  "server",
  "dist",
  "bin.mjs",
);

const DEFAULT_SERVER_ARCHIVE = path.join(DEFAULT_RESOURCES, "server.asar");
const DEFAULT_SERVER_ENTRY = path.join("apps", "server", "dist", "bin.mjs");
const DEFAULT_ASAR_CLI = path.join(
  os.homedir(),
  ".t3",
  "tools",
  "asar",
  "node_modules",
  "@electron",
  "asar",
  "bin",
  "asar.js",
);

const PATCHED_NAMES = new Map([
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "GPT-5.6 Sol"],
  ["claude-haiku-4-5", "GPT-5.6 Luna"],
]);

const HYBRID_DEFAULT_CONTEXT_WINDOW = 260000;
const HYBRID_EXTENDED_CONTEXT_WINDOW = 1000000;
const HYBRID_EXTENDED_AUTO_COMPACT_WINDOW = 900000;

const EFFORT_POLICIES = new Map([
  ["claude-fable-5", { values: ["low", "medium", "high"], defaultValue: "medium" }],
  ["claude-opus-5", { values: ["low", "medium", "high"], defaultValue: "medium" }],
  ["claude-sonnet-5", { values: ["low", "medium", "high", "xhigh"], defaultValue: "high", fastMode: true }],
  ["claude-haiku-4-5", { values: ["xhigh", "max"], defaultValue: "xhigh", fastMode: true }],
]);

const EFFORT_LABELS = new Map([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
  ["max", "Max"],
]);

const QWEN_MODEL_ID = "qwen3.8-27b";
const QWEN_MODEL_NAME = "Qwen 3.8 27B (VPN, 131k)";
const QWEN_CONTEXT_WINDOW = 131072;
// Qwen reserves up to 32k output tokens inside its 131,072-token total window.
// Compact at 95k so the next request retains a small safety margin.
const QWEN_AUTO_COMPACT_WINDOW = 95000;
const QWEN_CONTEXT_ENVIRONMENT_MARKER = "/* t3-patch:qwen-context-environment */";
const SUBAGENT_PATCH_MARKER = "/* t3-patch:subagent-frontmatter-resolve */";
const SUBAGENT_DISPLAY_ALIAS_MARKER = "/* t3-patch:subagent-model-display-aliases */";
const USAGE_RATE_PRIORITY_MARKER = "/* t3-patch:canonical-usage-rate-priority */";

function resolveSubagentDisplayConfig(input) {
  const trimmed = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const displayModel = (value) => {
    const model = trimmed(value);
    if (!model) return undefined;
    if (model === "sonnet" || /^claude-sonnet-5(?:\[|$)/i.test(model) || /^(?:anthropic\/)?gpt-5\.6-sol(?:\[|$)/i.test(model)) {
      return "gpt-5.6-sol";
    }
    if (model === "haiku" || /^claude-haiku-4-5(?:\[|$)/i.test(model) || /^(?:anthropic\/)?gpt-5\.6-luna(?:\[|$)/i.test(model)) {
      return "gpt-5.6-luna";
    }
    if (/^(?:anthropic\/)?gpt-5\.3-codex-spark(?:\[|$)/i.test(model)) return "gpt-5.3-codex-spark";
    return model;
  };
  const launchModel = trimmed(input.launchInput?.model);
  const rawLaunchEffort = input.launchInput?.effort;
  const launchEffort = trimmed(rawLaunchEffort) ??
    (typeof rawLaunchEffort === "number" && Number.isFinite(rawLaunchEffort)
      ? String(rawLaunchEffort)
      : undefined);
  const sessionModel = trimmed(input.sessionModel);
  const sessionEffort = trimmed(input.sessionEffort);
  const fallback = {
    model: displayModel(launchModel ?? sessionModel),
    effort: launchEffort ?? sessionEffort,
  };

  const subagentType = trimmed(input.subagentType);
  if (!subagentType || !/^[A-Za-z0-9_-]+$/.test(subagentType)) return fallback;

  try {
    const nodeFs = process.getBuiltinModule("node:fs");
    const nodePath = process.getBuiltinModule("node:path");
    const candidates = [];
    const projectDir = trimmed(input.projectDir);
    const homeDir = trimmed(input.homeDir);
    if (projectDir) candidates.push(nodePath.join(projectDir, ".claude", "agents", `${subagentType}.md`));
    if (homeDir) candidates.push(nodePath.join(homeDir, ".claude", "agents", `${subagentType}.md`));
    const file = candidates.find((candidate) => nodeFs.existsSync(candidate));
    if (!file) return fallback;

    const contents = nodeFs.readFileSync(file, "utf8");
    const frontmatter = contents.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) return fallback;

    const fields = {};
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^\s*(name|model|effort)\s*:\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).trim();
      }
      if (value) fields[match[1]] = value;
    }

    const aliases = {
      haiku: "claude-haiku-4-5",
      sonnet: "claude-sonnet-5",
      opus: "claude-opus-5",
      fable: "claude-fable-5",
    };
    const configuredModel = trimmed(fields.model);
    const model = displayModel(launchModel ??
      (configuredModel && configuredModel !== "inherit"
        ? aliases[configuredModel.toLowerCase()] ?? configuredModel
        : sessionModel));
    const configuredEffort = trimmed(fields.effort)?.toLowerCase();
    const effort = launchEffort ??
      (["low", "medium", "high", "xhigh", "max"].includes(configuredEffort)
        ? configuredEffort
        : sessionEffort);
    return { model, effort };
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceExactlyOnce(value, pattern, replacement, label) {
  const matches = value.match(pattern) || [];
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label}; found ${matches.length}.`);
  }
  return value.replace(pattern, replacement);
}

function replaceModelBlock(bundle, slug, transform) {
  const pattern = new RegExp(
    `\\t\\{\\r?\\n\\t\\tslug: "${escapeRegExp(slug)}",[\\s\\S]*?\\r?\\n\\t\\}(?=,?\\r?\\n(?:\\t\\{|\\]))`,
    "g",
  );
  const matches = [...bundle.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected one model block for ${slug}; found ${matches.length}.`);
  }
  return bundle.replace(pattern, (block) => transform(block));
}

function renderPatchedModelBlock(slug, eol) {
  const policy = EFFORT_POLICIES.get(slug);
  if (!policy) throw new Error(`No effort policy exists for ${slug}.`);
  const effortOptions = policy.values.map((value, index) => {
    const suffix = index === policy.values.length - 1 ? "" : ",";
    const defaultFlag = value === policy.defaultValue ? ", isDefault: true" : "";
    return `\t\t\t\t\t{ value: "${value}", label: "${EFFORT_LABELS.get(value)}"${defaultFlag} }${suffix}`;
  });
  const descriptors = [
    "\t\t\tbuildSelectOptionDescriptor({",
    '\t\t\t\tid: "effort",',
    '\t\t\t\tlabel: "Reasoning",',
    "\t\t\t\toptions: [",
    ...effortOptions,
    "\t\t\t\t]",
    "\t\t\t}),",
  ];
  if (policy.fastMode) {
    descriptors.push(
      "\t\t\tbuildBooleanOptionDescriptor({",
      '\t\t\t\tid: "fastMode",',
      '\t\t\t\tlabel: "Fast Mode"',
      "\t\t\t}),",
    );
  }
  descriptors.push(
    "\t\t\tbuildSelectOptionDescriptor({",
    '\t\t\t\tid: "contextWindow",',
    '\t\t\t\tlabel: "Context Window",',
    "\t\t\t\toptions: [",
    '\t\t\t\t\t{ value: "default", label: "260k", isDefault: true },',
    '\t\t\t\t\t{ value: "1m", label: "1M" }',
    "\t\t\t\t]",
    "\t\t\t})",
  );
  return [
    "\t{",
    `\t\tslug: "${slug}",`,
    `\t\tname: "${PATCHED_NAMES.get(slug)}",`,
    "\t\tisCustom: false,",
    "\t\tcapabilities: createModelCapabilities({ optionDescriptors: [",
    ...descriptors,
    "\t\t] }),",
    "\t}",
  ].join(eol);
}

function patchModelPolicy(bundle, slug) {
  return replaceModelBlock(bundle, slug, (block) =>
    renderPatchedModelBlock(slug, block.includes("\r\n") ? "\r\n" : "\n"),
  );
}

function patchEffortCarrierModelIds(bundle) {
  const pattern = /function resolveClaudeApiModelId\(modelSelection\) \{[\s\S]*?\r?\n\}\r?\n(?=function toTitleCaseWords)/g;
  const matches = bundle.match(pattern) || [];
  if (matches.length !== 1) {
    throw new Error(`Expected one resolveClaudeApiModelId function; found ${matches.length}.`);
  }
  const eol = matches[0].includes("\r\n") ? "\r\n" : "\n";
  const replacement = [
    "function resolveClaudeApiModelId(modelSelection) {",
    '\tconst isHybridSlot = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"].includes(modelSelection.model);',
    "\tconst supportsEffortCarrier = isHybridSlot || modelSelection.model === QWEN_MODEL_ID;",
    "\t// [1m] keeps extended context available; the picker controls per-session auto-compaction.",
    "\tlet baseModelId = isHybridSlot ? `${modelSelection.model}[1m]` : modelSelection.model;",
    '\tif (resolveClaudeContextWindow(modelSelection) === "1m" && !isHybridSlot) {',
    "\t\tbaseModelId = `${modelSelection.model}[1m]`;",
    "\t}",
    "\tif (supportsEffortCarrier) {",
    "\t\tconst caps = getClaudeModelCapabilities(modelSelection.model);",
    '\t\tconst rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");',
    "\t\tconst effort = resolveClaudeEffort(caps, rawEffort);",
    "\t\tif (effort) baseModelId = `${baseModelId}[effort=${effort}]`;",
    "\t\tif ([\"claude-sonnet-5\", \"claude-haiku-4-5\"].includes(modelSelection.model) && getModelSelectionBooleanOptionValue(modelSelection, \"fastMode\") === true) {",
    "\t\t\tbaseModelId = `${baseModelId}[fast=true]`;",
    "\t\t}",
    "\t}",
    "\treturn baseModelId;",
    "}",
    "",
  ].join(eol);
  return bundle.replace(pattern, replacement);
}

function patchHybridContextWindows(bundle) {
  const marker = "const HYBRID_CONTEXT_MODELS = new Set([";
  if (!bundle.includes(marker)) {
    bundle = replaceExactlyOnce(
      bundle,
      /function selectedClaudeContextWindow\(modelSelection\) \{\r?\n/g,
      [
        'const HYBRID_CONTEXT_MODELS = new Set(["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);',
        `const HYBRID_DEFAULT_CONTEXT_WINDOW = ${HYBRID_DEFAULT_CONTEXT_WINDOW};`,
        `const HYBRID_EXTENDED_CONTEXT_WINDOW = ${HYBRID_EXTENDED_CONTEXT_WINDOW};`,
        `const HYBRID_EXTENDED_AUTO_COMPACT_WINDOW = ${HYBRID_EXTENDED_AUTO_COMPACT_WINDOW};`,
        "function selectedClaudeContextWindow(modelSelection) {",
        '\tif (HYBRID_CONTEXT_MODELS.has(modelSelection?.model)) return resolveClaudeContextWindow(modelSelection) === "1m" ? HYBRID_EXTENDED_CONTEXT_WINDOW : HYBRID_DEFAULT_CONTEXT_WINDOW;',
        "",
      ].join(bundle.includes("\r\n") ? "\r\n" : "\n"),
      "selected Claude context-window function",
    );
  }

  if (!bundle.includes("const HYBRID_EXTENDED_AUTO_COMPACT_WINDOW = 900000;")) {
    bundle = replaceExactlyOnce(
      bundle,
      /const HYBRID_EXTENDED_CONTEXT_WINDOW = 1000000;\r?\n/g,
      `const HYBRID_EXTENDED_CONTEXT_WINDOW = 1000000;${bundle.includes("\r\n") ? "\r\n" : "\n"}const HYBRID_EXTENDED_AUTO_COMPACT_WINDOW = 900000;${bundle.includes("\r\n") ? "\r\n" : "\n"}`,
      "extended hybrid context constant",
    );
  }

  const qwenSetting = `...modelSelection?.model === QWEN_MODEL_ID ? { autoCompactWindow: ${QWEN_AUTO_COMPACT_WINDOW} } : {}`;
  const legacyHybridSetting = '...HYBRID_CONTEXT_MODELS.has(modelSelection?.model) ? { autoCompactWindow: resolveClaudeContextWindow(modelSelection) === "1m" ? HYBRID_EXTENDED_CONTEXT_WINDOW : HYBRID_DEFAULT_CONTEXT_WINDOW } : {}';
  const hybridSetting = '...HYBRID_CONTEXT_MODELS.has(modelSelection?.model) ? { autoCompactWindow: resolveClaudeContextWindow(modelSelection) === "1m" ? HYBRID_EXTENDED_AUTO_COMPACT_WINDOW : HYBRID_DEFAULT_CONTEXT_WINDOW } : {}';
  bundle = bundle.replaceAll(legacyHybridSetting, hybridSetting);
  if (!bundle.includes(hybridSetting)) {
    const matches = bundle.split(qwenSetting).length - 1;
    if (matches < 2) throw new Error(`Expected at least two Claude settings blocks; found ${matches}.`);
    bundle = bundle.replaceAll(qwenSetting, `${qwenSetting},${bundle.includes("\r\n") ? "\r\n" : "\n"}\t\t\t${hybridSetting}`);
  }
  return bundle;
}

function patchQwenModel(bundle) {
  const defaultCapabilities = 'const DEFAULT_CLAUDE_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });';
  const eol = bundle.includes('\r\n') ? '\r\n' : '\n';
  const legacyQwenCapabilities = [
    'const QWEN_MODEL_CAPABILITIES = createModelCapabilities({',
    '\toptionDescriptors: [buildSelectOptionDescriptor({',
    '\t\tid: "contextWindow",',
    '\t\tlabel: "Context Window",',
    '\t\toptions: [{ value: "131k", label: "131k", isDefault: true }]',
    '\t})]',
    '});',
  ].join(eol);
  const qwenCapabilities = [
    'const QWEN_MODEL_CAPABILITIES = createModelCapabilities({',
    '\toptionDescriptors: [',
    '\t\tbuildSelectOptionDescriptor({',
    '\t\t\tid: "effort",',
    '\t\t\tlabel: "Reasoning",',
    '\t\t\toptions: [',
    '\t\t\t\t{ value: "low", label: "Low" },',
    '\t\t\t\t{ value: "medium", label: "Medium" },',
    '\t\t\t\t{ value: "xhigh", label: "Extra High", isDefault: true }',
    '\t\t\t]',
    '\t\t}),',
    '\t\tbuildSelectOptionDescriptor({',
    '\t\t\tid: "contextWindow",',
    '\t\t\tlabel: "Context Window",',
    '\t\t\toptions: [{ value: "131k", label: "131k", isDefault: true }]',
    '\t\t})',
    '\t]',
    '});',
  ].join(eol);
  if (!bundle.includes('const QWEN_MODEL_ID = "qwen3.8-27b";')) {
    const qwenSupport = [
      defaultCapabilities,
      `const QWEN_MODEL_ID = "${QWEN_MODEL_ID}";`,
      qwenCapabilities,
      'function withQwenClaudeModel(models) {',
      '\treturn models.map((model) => model.slug === QWEN_MODEL_ID ? {',
      '\t\t...model,',
      `\t\tname: "${QWEN_MODEL_NAME}",`,
      '\t\tcapabilities: QWEN_MODEL_CAPABILITIES',
      '\t} : model);',
      '}',
    ].join(eol);
    bundle = replaceExactlyOnce(
      bundle,
      new RegExp(escapeRegExp(defaultCapabilities), 'g'),
      qwenSupport,
      'default Claude capabilities declaration',
    );
  }
  bundle = bundle.replaceAll(legacyQwenCapabilities, qwenCapabilities);

  if (!bundle.includes('if (slug === QWEN_MODEL_ID) return QWEN_MODEL_CAPABILITIES;')) {
    bundle = replaceExactlyOnce(
      bundle,
      /function getClaudeModelCapabilities\(model\) \{[\s\S]*?\r?\n\}\r?\n(?=(?:const allModels|function resolveClaudeEffort))/g,
      [
        'function getClaudeModelCapabilities(model) {',
        '\tconst slug = model?.trim();',
        '\tif (slug === QWEN_MODEL_ID) return QWEN_MODEL_CAPABILITIES;',
        '\treturn BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? DEFAULT_CLAUDE_MODEL_CAPABILITIES;',
        '}',
        '',
      ].join(bundle.includes('\r\n') ? '\r\n' : '\n'),
      'getClaudeModelCapabilities function',
    );
  }

  const customModelsPattern = /(?<!withQwenClaudeModel\()providerModelsFromSettings\(([^\r\n;]*DEFAULT_CLAUDE_MODEL_CAPABILITIES)\)/g;
  bundle = bundle.replace(customModelsPattern, 'withQwenClaudeModel(providerModelsFromSettings($1))');

  if (!bundle.includes('if (modelSelection?.model === QWEN_MODEL_ID) return 131072;')) {
    bundle = replaceExactlyOnce(
      bundle,
      /function selectedClaudeContextWindow\(modelSelection\) \{\r?\n/g,
      `function selectedClaudeContextWindow(modelSelection) {${bundle.includes('\r\n') ? '\r\n' : '\n'}\tif (modelSelection?.model === QWEN_MODEL_ID) return ${QWEN_CONTEXT_WINDOW};${bundle.includes('\r\n') ? '\r\n' : '\n'}`,
      'selectedClaudeContextWindow function',
    );
  }

  bundle = bundle.replaceAll('autoCompactWindow: 130000', `autoCompactWindow: ${QWEN_AUTO_COMPACT_WINDOW}`);
  if (!bundle.includes(`autoCompactWindow: ${QWEN_AUTO_COMPACT_WINDOW}`)) {
    const compactPattern = /\.\.\.ultracode \? \{ ultracode: true \} : \{\}/g;
    const matches = bundle.match(compactPattern) || [];
    if (matches.length < 2) {
      throw new Error(`Expected at least two Claude settings blocks; found ${matches.length}.`);
    }
    bundle = bundle.replace(
      compactPattern,
      `...ultracode ? { ultracode: true } : {},${bundle.includes('\r\n') ? '\r\n' : '\n'}\t\t\t...modelSelection?.model === QWEN_MODEL_ID ? { autoCompactWindow: ${QWEN_AUTO_COMPACT_WINDOW} } : {}`,
    );
  }
  return bundle;
}

function patchQwenContextEnvironment(bundle) {
  const eol = bundle.includes("\r\n") ? "\r\n" : "\n";
  if (!bundle.includes(QWEN_CONTEXT_ENVIRONMENT_MARKER)) {
    const helper = [
      QWEN_CONTEXT_ENVIRONMENT_MARKER,
      "function claudeEnvironmentForModel(modelSelection, baseEnvironment) {",
      "\tif (modelSelection?.model !== QWEN_MODEL_ID) return baseEnvironment;",
      "\treturn {",
      "\t\t...baseEnvironment,",
      `\t\tCLAUDE_CODE_MAX_CONTEXT_TOKENS: "${QWEN_CONTEXT_WINDOW}",`,
      `\t\tCLAUDE_CODE_AUTO_COMPACT_WINDOW: "${QWEN_AUTO_COMPACT_WINDOW}"`,
      "\t};",
      "}",
    ].join(eol);
    bundle = replaceExactlyOnce(
      bundle,
      /const QWEN_MODEL_ID = "qwen3\.8-27b";\r?\n/g,
      `$&${helper}${eol}`,
      "Qwen model declaration for context environment helper",
    );
  }

  const patchedEnvironment = "env: claudeEnvironmentForModel(modelSelection, claudeEnvironment),";
  if (!bundle.includes(patchedEnvironment)) {
    bundle = replaceExactlyOnce(
      bundle,
      /((?:supportedDialogKinds: \["resume_return"\]|canUseTool),\r?\n\s*)env: claudeEnvironment,(\r?\n\s*additionalDirectories,)/g,
      `$1${patchedEnvironment}$2`,
      "Claude agent query environment",
    );
  }
  return bundle;
}

function patchSubagentMetadata(bundle) {
  const eol = bundle.includes("\r\n") ? "\r\n" : "\n";
  if (bundle.includes(SUBAGENT_PATCH_MARKER)) {
    if (bundle.includes(SUBAGENT_DISPLAY_ALIAS_MARKER)) return bundle;
    const legacyHelperPattern = /\/\* t3-patch:subagent-frontmatter-resolve \*\/\r?\nfunction resolveSubagentDisplayConfig\(input\) \{[\s\S]*?\r?\n\}\r?\n(?=\r?\nconst DEFAULT_CLAUDE_MODEL_CAPABILITIES)/g;
    return replaceExactlyOnce(
      bundle,
      legacyHelperPattern,
      `${SUBAGENT_PATCH_MARKER}${eol}${SUBAGENT_DISPLAY_ALIAS_MARKER}${eol}${resolveSubagentDisplayConfig.toString()}${eol}`,
      "legacy subagent display helper",
    );
  }
  const helperAnchor = /const DEFAULT_CLAUDE_MODEL_CAPABILITIES = createModelCapabilities\(\{ optionDescriptors: \[\] \}\);/g;
  bundle = replaceExactlyOnce(
    bundle,
    helperAnchor,
    `${SUBAGENT_PATCH_MARKER}${eol}${SUBAGENT_DISPLAY_ALIAS_MARKER}${eol}${resolveSubagentDisplayConfig.toString()}${eol}${eol}$&`,
    "default Claude capabilities declaration for subagent helper",
  );

  const launchMetadataPattern = /([\t ]*)const model = (bufferedModel \?\? )?trimmedString\(launchInput\?\.model\) \?\? trimmedString\(context\.session\.model \?\? void 0\);\r?\n\1const rawLaunchEffort = launchInput\?\.effort;\r?\n\1const effort = trimmedString\(rawLaunchEffort\) \?\? \(typeof rawLaunchEffort === "number" && Number\.isFinite\(rawLaunchEffort\) \? String\(rawLaunchEffort\) : context\.currentEffort\);/g;
  const matches = [...bundle.matchAll(launchMetadataPattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected one Claude subagent launch metadata block; found ${matches.length}.`);
  }
  const indent = matches[0][1];
  const launchConfig = matches[0][2]
    ? "bufferedModel ? { ...launchInput, model: bufferedModel } : launchInput"
    : "launchInput";
  const replacement = [
    `${indent}const { model, effort } = resolveSubagentDisplayConfig({`,
    `${indent}\tsubagentType: message.subagent_type,`,
    `${indent}\tprojectDir: context.session.cwd,`,
    `${indent}\thomeDir: process.env.USERPROFILE ?? process.env.HOME,`,
    `${indent}\tsessionModel: trimmedString(context.session.model ?? void 0),`,
    `${indent}\tsessionEffort: context.currentEffort,`,
    `${indent}\tlaunchInput: ${launchConfig}`,
    `${indent}});`,
  ].join(eol);
  return bundle.replace(launchMetadataPattern, replacement);
}

function patchUsageRatePriority(bundle) {
  if (bundle.includes(USAGE_RATE_PRIORITY_MARKER)) return bundle;
  const hasNativeQualifiedRatePriority = [
    "const key = normalizeRateKey(name);",
    "const alias = bareModelName(key);",
    "alias === key || table.has(alias)",
    "if (rate !== null) table.set(alias, rate);",
  ].every((fragment) => bundle.includes(fragment));
  if (hasNativeQualifiedRatePriority) {
    return replaceExactlyOnce(
      bundle,
      /function parseRateTable\(document\) \{\r?\n/g,
      `${USAGE_RATE_PRIORITY_MARKER}${bundle.includes("\r\n") ? "\r\n" : "\n"}$&`,
      "native qualified-key usage pricing function",
    );
  }
  // Bundlers may suffix imported/local identifiers (for example finiteNumber$1).
  // Capture the helper and require the same identifier for both cache-rate fields.
  const pattern = /\t\ttable\.set\(normalizeModelName\(name\), \{\r?\n\t\t\tinputCostPerToken: input,\r?\n\t\t\toutputCostPerToken: output,\r?\n\t\t\tcacheReadCostPerToken: ([A-Za-z_$][\w$]*)\(entry\.cache_read_input_token_cost\) \?\? input,\r?\n\t\t\tcacheCreationCostPerToken: \1\(entry\.cache_creation_input_token_cost\) \?\? input\r?\n\t\t\}\);/g;
  const matches = [...bundle.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected one usage rate insertion block; found ${matches.length}.`);
  }
  const matchedBlock = matches[0][0];
  const finiteNumberHelper = matches[0][1];
  const eol = matchedBlock.includes("\r\n") ? "\r\n" : "\n";
  const replacement = [
    `\t\t${USAGE_RATE_PRIORITY_MARKER}`,
    "\t\tconst normalizedName = normalizeModelName(name);",
    "\t\tconst isCanonicalName = name.trim().toLowerCase() === normalizedName;",
    "\t\tif (!table.has(normalizedName) || isCanonicalName) table.set(normalizedName, {",
    "\t\t\tinputCostPerToken: input,",
    "\t\t\toutputCostPerToken: output,",
    `\t\t\tcacheReadCostPerToken: ${finiteNumberHelper}(entry.cache_read_input_token_cost) ?? input,`,
    `\t\t\tcacheCreationCostPerToken: ${finiteNumberHelper}(entry.cache_creation_input_token_cost) ?? input`,
    "\t\t});",
  ].join(eol);
  // Use a callback so a bundler suffix such as `$1` is kept literally instead
  // of being interpreted as a String.replace capture token.
  return bundle.replace(pattern, () => replacement);
}

function isPickerPatched(bundle) {
  const policiesMatch = [...EFFORT_POLICIES].every(([slug, policy]) => {
    const pattern = new RegExp(
      `\\t\\{\\r?\\n\\t\\tslug: "${escapeRegExp(slug)}",[\\s\\S]*?\\r?\\n\\t\\}(?=,?\\r?\\n(?:\\t\\{|\\]))`,
    );
    const block = bundle.match(pattern)?.[0];
    if (!block) return false;
    const effortEnd = block.indexOf('id: "contextWindow"');
    const effortSection = effortEnd >= 0 ? block.slice(0, effortEnd) : block;
    const values = [...effortSection.matchAll(/value: "(low|medium|high|xhigh|max|ultracode|ultrathink)"/g)].map(
      (match) => match[1],
    );
    const defaultPattern = new RegExp(
      `value: "${escapeRegExp(policy.defaultValue)}", label: "[^"]+", isDefault: true`,
    );
    const contextWindowMatches = /id: "contextWindow",[\s\S]*?value: "default",[\s\S]*?label: "260k",[\s\S]*?isDefault: true[\s\S]*?value: "1m",[\s\S]*?label: "1M"/.test(
      block,
    );
    const fastModeMatches = block.includes('id: "fastMode"') === Boolean(policy.fastMode);
    return (
      JSON.stringify(values) === JSON.stringify(policy.values) &&
      defaultPattern.test(effortSection) &&
      contextWindowMatches &&
      fastModeMatches
    );
  });
  const qwenCompactMatches = bundle.match(new RegExp(`autoCompactWindow: ${QWEN_AUTO_COMPACT_WINDOW}`, "g")) || [];
  const checks = {
    names: [...PATCHED_NAMES.values()].every((name) => bundle.includes(`name: "${name}"`)),
    policies: policiesMatch,
    compatibility: bundle.includes('model !== "claude-haiku-4-5"'),
    effortCarrier: bundle.includes('baseModelId = `${baseModelId}[effort=${effort}]`;'),
    fastCarrier: bundle.includes('baseModelId = `${baseModelId}[fast=true]`;'),
    hybridSlots: bundle.includes('const isHybridSlot = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"].includes(modelSelection.model);'),
    qwenEffortCarrier: bundle.includes('const supportsEffortCarrier = isHybridSlot || modelSelection.model === QWEN_MODEL_ID;'),
    baseModel: bundle.includes('let baseModelId = isHybridSlot ? `${modelSelection.model}[1m]` : modelSelection.model;'),
    contextCarrier: bundle.includes('resolveClaudeContextWindow(modelSelection) === "1m" && !isHybridSlot'),
    contextModels: bundle.includes('const HYBRID_CONTEXT_MODELS = new Set(["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);'),
    compactConstant: bundle.includes('const HYBRID_EXTENDED_AUTO_COMPACT_WINDOW = 900000;'),
    contextLabels: bundle.includes('label: "260k"') && bundle.includes('{ value: "1m", label: "1M" }'),
    compactSettings: (bundle.match(/HYBRID_CONTEXT_MODELS\.has\(modelSelection\?\.model\) \? \{ autoCompactWindow:/g) || []).length >= 2,
    oldNamesGone: !bundle.includes('name: "Claude Sonnet 5"') && !bundle.includes('name: "Claude Haiku 4.5"'),
    qwenId: bundle.includes('const QWEN_MODEL_ID = "qwen3.8-27b";'),
    qwenName: bundle.includes('name: "Qwen 3.8 27B (VPN, 131k)"'),
    qwenEfforts: bundle.includes('{ value: "low", label: "Low" }') && bundle.includes('{ value: "medium", label: "Medium" }') && bundle.includes('{ value: "xhigh", label: "Extra High", isDefault: true }'),
    qwenContext: bundle.includes('options: [{ value: "131k", label: "131k", isDefault: true }]'),
    qwenCapabilities: bundle.includes('if (slug === QWEN_MODEL_ID) return QWEN_MODEL_CAPABILITIES;'),
    qwenModels: bundle.includes('withQwenClaudeModel(providerModelsFromSettings('),
    qwenWindow: bundle.includes('if (modelSelection?.model === QWEN_MODEL_ID) return 131072;'),
    qwenCompaction: qwenCompactMatches.length >= 2,
    qwenContextEnvironment:
      bundle.includes(QWEN_CONTEXT_ENVIRONMENT_MARKER) &&
      bundle.includes("function claudeEnvironmentForModel(modelSelection, baseEnvironment)") &&
      bundle.includes("env: claudeEnvironmentForModel(modelSelection, claudeEnvironment),"),
  };
  isPickerPatched.failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return isPickerPatched.failures.length === 0;
}

function isSubagentMetadataPatched(bundle) {
  return (
    bundle.includes(SUBAGENT_PATCH_MARKER) &&
    bundle.includes(SUBAGENT_DISPLAY_ALIAS_MARKER) &&
    bundle.includes("function resolveSubagentDisplayConfig(input)") &&
    bundle.includes("subagentType: message.subagent_type") &&
    bundle.includes("projectDir: context.session.cwd") &&
    !bundle.includes("const rawLaunchEffort = launchInput?.effort;")
  );
}

function isPatched(bundle) {
  return (
    isPickerPatched(bundle) &&
    isSubagentMetadataPatched(bundle) &&
    bundle.includes(USAGE_RATE_PRIORITY_MARKER)
  );
}

function patchBundle(input) {
  if (isPatched(input)) {
    return { status: "already-patched", bundle: input };
  }

  let bundle = input;
  if (!isPickerPatched(bundle)) {
    for (const slug of PATCHED_NAMES.keys()) bundle = patchModelPolicy(bundle, slug);

    if (!bundle.includes('model !== "claude-haiku-4-5"')) {
      bundle = replaceExactlyOnce(
        bundle,
        /model !== "claude-sonnet-5"\) return "max";/g,
        'model !== "claude-sonnet-5" && model !== "claude-haiku-4-5") return "max";',
        "Claude effort compatibility condition",
      );
    }
    bundle = patchEffortCarrierModelIds(bundle);
    bundle = patchQwenModel(bundle);
    bundle = patchQwenContextEnvironment(bundle);
    bundle = patchHybridContextWindows(bundle);
  }
  bundle = patchSubagentMetadata(bundle);
  bundle = patchUsageRatePriority(bundle);

  if (!isPatched(bundle)) {
    throw new Error(`Picker patch verification failed (picker=${isPickerPatched(bundle)}:${isPickerPatched.failures.join(",")}, subagent=${isSubagentMetadataPatched(bundle)}, usage=${bundle.includes(USAGE_RATE_PRIORITY_MARKER)}).`);
  }
  return { status: "patched", bundle };
}

function patchFile(filePath = DEFAULT_BUNDLE, backupDirectory) {
  const original = fs.readFileSync(filePath, "utf8");
  const beforeHash = sha256(original);
  const result = patchBundle(original);
  if (result.status === "already-patched") {
    return {
      status: result.status,
      file: filePath,
      sha256: beforeHash,
    };
  }

  const backups = backupDirectory || path.join(os.homedir(), ".t3", "backups", "t3-hybrid-picker");
  fs.mkdirSync(backups, { recursive: true });
  const backup = path.join(backups, `bin.mjs.${beforeHash.slice(0, 16)}.bak`);
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(filePath, backup);
  }
  fs.writeFileSync(filePath, result.bundle, "utf8");

  const written = fs.readFileSync(filePath, "utf8");
  if (!isPatched(written)) {
    fs.copyFileSync(backup, filePath);
    throw new Error("Written picker patch failed verification; the backup was restored.");
  }
  return {
    status: result.status,
    file: filePath,
    backup,
    sha256Before: beforeHash,
    sha256After: sha256(written),
  };
}

function resolveDefaultTarget(resourcesDirectory = DEFAULT_RESOURCES) {
  const legacyBundle = path.join(
    resourcesDirectory,
    "app.asar.unpacked",
    "apps",
    "server",
    "dist",
    "bin.mjs",
  );
  if (fs.existsSync(legacyBundle)) {
    return { kind: "file", file: legacyBundle };
  }

  const archive = path.join(resourcesDirectory, "server.asar");
  if (fs.existsSync(archive)) {
    return { kind: "asar", archive, entry: DEFAULT_SERVER_ENTRY };
  }

  throw new Error(`No supported T3 server bundle was found below ${resourcesDirectory}.`);
}

function loadAsarSupport(asarCli) {
  if (!fs.existsSync(asarCli)) {
    throw new Error(`The required @electron/asar CLI was not found: ${asarCli}`);
  }
  const packageDirectory = path.resolve(path.dirname(asarCli), "..");
  return {
    asar: require(packageDirectory),
    Pickle: require(path.join(packageDirectory, "lib", "pickle")).Pickle,
  };
}

function findArchiveNode(header, entry) {
  let node = header;
  for (const segment of entry.split(/[\\/]+/).filter(Boolean)) {
    node = node.files?.[segment];
    if (!node) throw new Error(`T3 server archive does not contain ${entry}.`);
  }
  return node;
}

function visitArchiveNodes(node, callback) {
  for (const child of Object.values(node.files || {})) {
    callback(child);
    if (child.files) visitArchiveNodes(child, callback);
  }
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fileIntegrity(buffer, blockSize = 4 * 1024 * 1024) {
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    blocks.push(sha256Hex(buffer.subarray(offset, Math.min(offset + blockSize, buffer.length))));
  }
  return { algorithm: "SHA256", hash: sha256Hex(buffer), blockSize, blocks };
}

function replacePackedArchiveEntry(archive, entry, replacement, output, asarCli) {
  const { asar, Pickle } = loadAsarSupport(asarCli);
  const raw = asar.getRawHeader(archive);
  const header = raw.header;
  const target = findArchiveNode(header, entry);
  if (target.unpacked || typeof target.offset !== "string") {
    throw new Error(`${entry} must be a packed file inside the T3 server archive.`);
  }

  const oldOffset = BigInt(target.offset);
  const oldSize = BigInt(target.size);
  const delta = BigInt(replacement.length) - oldSize;
  visitArchiveNodes(header, (node) => {
    if (node === target || typeof node.offset !== "string") return;
    const offset = BigInt(node.offset);
    if (offset > oldOffset) node.offset = (offset + delta).toString();
  });
  target.size = replacement.length;
  target.integrity = fileIntegrity(replacement);

  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(header));
  const headerBuffer = headerPickle.toBuffer();
  const sizePickle = Pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);
  const sizeBuffer = sizePickle.toBuffer();

  const original = fs.readFileSync(archive);
  const dataStart = 8 + raw.headerSize;
  const packedStart = dataStart + Number(oldOffset);
  const suffixStart = packedStart + Number(oldSize);
  fs.writeFileSync(output, Buffer.concat([
    sizeBuffer,
    headerBuffer,
    original.subarray(dataStart, packedStart),
    replacement,
    original.subarray(suffixStart),
  ]));

  asar.uncache(output);
  const verified = asar.extractFile(output, entry);
  if (!verified.equals(replacement)) {
    throw new Error(`Patched archive entry ${entry} failed byte-for-byte verification.`);
  }
}

function patchAsarTarget(target, backupDirectory, asarCli = DEFAULT_ASAR_CLI) {
  const archive = target.archive;
  const entry = target.entry || DEFAULT_SERVER_ENTRY;
  const archiveContents = fs.readFileSync(archive);
  const beforeHash = sha256(archiveContents);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-picker-asar-"));
  const packed = path.join(temporaryRoot, "server.asar");
  let backup;
  let archiveModified = false;

  try {
    const { asar } = loadAsarSupport(asarCli);
    const originalBundle = asar.extractFile(archive, entry).toString("utf8");
    const result = patchBundle(originalBundle);
    if (result.status === "already-patched") {
      return { status: result.status, file: archive, sha256: beforeHash };
    }

    const backups = backupDirectory || path.join(os.homedir(), ".t3", "backups", "t3-hybrid-picker");
    fs.mkdirSync(backups, { recursive: true });
    backup = path.join(backups, `server.asar.${beforeHash.slice(0, 16)}.bak`);
    if (!fs.existsSync(backup)) fs.copyFileSync(archive, backup);

    replacePackedArchiveEntry(archive, entry, Buffer.from(result.bundle, "utf8"), packed, asarCli);
    const verifiedBundle = asar.extractFile(packed, entry).toString("utf8");
    if (!isPatched(verifiedBundle)) {
      throw new Error("Packed T3 server archive failed picker patch verification.");
    }

    fs.copyFileSync(packed, archive);
    archiveModified = true;
    asar.uncache(archive);
    const writtenHash = sha256(fs.readFileSync(archive));
    const packedHash = sha256(fs.readFileSync(packed));
    if (writtenHash !== packedHash) {
      throw new Error("Written T3 server archive does not match the verified package.");
    }
    if (!isPatched(asar.extractFile(archive, entry).toString("utf8"))) {
      throw new Error("Installed T3 server archive failed picker patch verification.");
    }

    return {
      status: result.status,
      file: archive,
      backup,
      sha256Before: beforeHash,
      sha256After: writtenHash,
    };
  } catch (error) {
    if (archiveModified && backup && fs.existsSync(backup)) {
      fs.copyFileSync(backup, archive);
    }
    throw error;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function checkTarget(target, asarCli = DEFAULT_ASAR_CLI) {
  const bundle = target.kind === "asar"
    ? loadAsarSupport(asarCli).asar.extractFile(target.archive, target.entry || DEFAULT_SERVER_ENTRY).toString("utf8")
    : fs.readFileSync(target.file, "utf8");
  const patched = isPatched(bundle);
  return {
    status: patched ? "already-patched" : "patch-required",
    file: target.kind === "asar" ? target.archive : target.file,
    pickerFailures: patched ? [] : [...(isPickerPatched.failures || [])],
    subagentMetadataPatched: isSubagentMetadataPatched(bundle),
    usageRatePriorityPatched: bundle.includes(USAGE_RATE_PRIORITY_MARKER),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  const backupIndex = args.indexOf("--backup-dir");
  const backupDir = backupIndex >= 0 ? args[backupIndex + 1] : undefined;
  try {
    const target = fileIndex >= 0
      ? { kind: "file", file: args[fileIndex + 1] }
      : resolveDefaultTarget();
    const result = args.includes("--check")
      ? checkTarget(target)
      : target.kind === "asar"
        ? patchAsarTarget(target, backupDir)
        : patchFile(target.file, backupDir);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_BUNDLE,
  DEFAULT_ASAR_CLI,
  PATCHED_NAMES,
  checkTarget,
  isPatched,
  patchAsarTarget,
  patchBundle,
  patchFile,
  resolveDefaultTarget,
  resolveSubagentDisplayConfig,
};
