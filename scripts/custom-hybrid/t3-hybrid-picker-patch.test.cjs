const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  checkTarget,
  patchAsarTarget,
  patchBundle,
  resolveDefaultTarget,
  resolveSubagentDisplayConfig,
} = require('./t3-hybrid-picker-patch.cjs');

const ASAR_CLI = path.join(
  os.homedir(), '.t3', 'tools', 'asar', 'node_modules', '@electron', 'asar', 'bin', 'asar.js',
);

function withAgentDirs(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-subagent-config-'));
  const projectDir = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(path.join(projectDir, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude', 'agents'), { recursive: true });
  try {
    return callback({ projectDir, homeDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeAgent(root, fileName, frontmatter) {
  const file = path.join(root, '.claude', 'agents', fileName);
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\nAgent instructions.\n`, 'utf8');
}

function modelBlock(slug, name) {
  return [
    '\t{',
    `\t\tslug: "${slug}",`,
    `\t\tname: "${name}",`,
    '\t\tisCustom: false,',
    '\t\tcapabilities: createModelCapabilities({ optionDescriptors: [] }),',
    '\t}',
  ].join('\n');
}

function unpatchedBundleFixture() {
  return [
    'const DEFAULT_CLAUDE_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });',
    'const CATALOG = [',
    modelBlock('claude-fable-5', 'Claude Fable 5') + ',',
    modelBlock('claude-opus-5', 'Claude Opus 5') + ',',
    modelBlock('claude-sonnet-5', 'Claude Sonnet 5') + ',',
    modelBlock('claude-haiku-4-5', 'Claude Haiku 4.5'),
    '];',
    'const BUILT_IN_MODELS = CATALOG;',
    'function providerModelsFromSettings(builtInModels, customModels, customModelCapabilities) {',
    '\treturn [...builtInModels, ...customModels.map((slug) => ({ slug, name: slug, isCustom: true, capabilities: customModelCapabilities }))];',
    '}',
    'function getBuiltInClaudeModelsForVersion() { return BUILT_IN_MODELS; }',
    'function getClaudeModelCapabilities(model) {',
    '\tconst slug = model?.trim();',
    '\treturn BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ?? DEFAULT_CLAUDE_MODEL_CAPABILITIES;',
    '}',
    'const allModels = providerModelsFromSettings(BUILT_IN_MODELS, ["qwen3.8-27b"], DEFAULT_CLAUDE_MODEL_CAPABILITIES);',
    'const versionModels = providerModelsFromSettings(getBuiltInClaudeModelsForVersion(), ["qwen3.8-27b"], DEFAULT_CLAUDE_MODEL_CAPABILITIES);',
    'const pendingModels = providerModelsFromSettings(BUILT_IN_MODELS, ["qwen3.8-27b"], DEFAULT_CLAUDE_MODEL_CAPABILITIES);',
    'function normalizeEffort(model) {',
    '\tif (model !== "claude-fable-5" && model !== "claude-opus-5" && model !== "claude-sonnet-5") return "max";',
    '}',
    'function resolveClaudeContextWindow(modelSelection) {',
    '\treturn getModelSelectionStringOptionValue(modelSelection, "contextWindow");',
    '}',
    'function resolveClaudeApiModelId(modelSelection) {',
    '\tswitch (resolveClaudeContextWindow(modelSelection)) {',
    '\t\tcase "1m": return `${modelSelection.model}[1m]`;',
    '\t\tdefault: return modelSelection.model;',
    '\t}',
    '}',
    'function toTitleCaseWords(value) { return value; }',
    'function selectedClaudeContextWindow(modelSelection) {',
    '\tswitch (modelSelection?.model) {',
    '\t\tcase "claude-opus-4-8": return 1000000;',
    '\t}',
    '\tswitch (resolveClaudeContextWindow(modelSelection)) {',
    '\t\tcase "1m": return 1000000;',
    '\t\tcase "200k": return 200000;',
    '\t\tdefault: return undefined;',
    '\t}',
    '}',
    'function buildTextSettings(modelSelection, ultracode = false) {',
    '\tconst settings = {',
    '\t\t...ultracode ? { ultracode: true } : {}',
    '\t};',
    '\treturn settings;',
    '}',
    'function buildAgentSettings(modelSelection, ultracode = false) {',
    '\tconst settings = {',
    '\t\t...ultracode ? { ultracode: true } : {}',
    '\t};',
    '\treturn settings;',
    '}',
    'function buildAgentEnvironment(modelSelection, claudeEnvironment) {',
    '\tconst additionalDirectories = [];',
    '\tconst queryOptions = {',
    '\t\tsupportedDialogKinds: ["resume_return"],',
    '\t\tenv: claudeEnvironment,',
    '\t\tadditionalDirectories,',
    '\t};',
    '\treturn queryOptions.env;',
    '}',
    'function* handleClaudeSystemMessage(message, context) {',
    '\tswitch (message.subtype) {',
    '\t\tcase "task_started": {',
    '\t\t\tconst launchingTool = message.tool_use_id ? Array.from(context.inFlightTools.values()).find((tool) => tool.itemId === message.tool_use_id) : void 0;',
    '\t\t\tconst owningAgentId = launchingTool?.agentId;',
    '\t\t\tconst launchInput = launchingTool?.input;',
    '\t\t\tconst model = trimmedString(launchInput?.model) ?? trimmedString(context.session.model ?? void 0);',
    '\t\t\tconst rawLaunchEffort = launchInput?.effort;',
    '\t\t\tconst effort = trimmedString(rawLaunchEffort) ?? (typeof rawLaunchEffort === "number" && Number.isFinite(rawLaunchEffort) ? String(rawLaunchEffort) : context.currentEffort);',
    '\t\t\treturn { model, effort, owningAgentId };',
    '\t\t}',
    '\t}',
    '}',
    'function finiteNumber(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }',
    'function normalizeModelName(model) {',
    '\tconst trimmed = model.trim().toLowerCase();',
    '\tconst slash = trimmed.lastIndexOf("/");',
    '\treturn slash === -1 ? trimmed : trimmed.slice(slash + 1);',
    '}',
    'function parseRateTable(document) {',
    '\tconst table = new Map();',
    '\tif (typeof document !== "object" || document === null) return table;',
    '\tfor (const [name, raw] of Object.entries(document)) {',
    '\t\tif (typeof raw !== "object" || raw === null) continue;',
    '\t\tconst entry = raw;',
    '\t\tconst input = finiteNumber(entry.input_cost_per_token);',
    '\t\tconst output = finiteNumber(entry.output_cost_per_token);',
    '\t\tif (input === null || output === null) continue;',
    '\t\ttable.set(normalizeModelName(name), {',
    '\t\t\tinputCostPerToken: input,',
    '\t\t\toutputCostPerToken: output,',
    '\t\t\tcacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,',
    '\t\t\tcacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input',
    '\t\t});',
    '\t}',
    '\treturn table;',
    '}',
  ].join('\n');
}

function executePatchedFixture() {
  const { bundle } = patchBundle(unpatchedBundleFixture());
  const factory = new Function(
    'createModelCapabilities',
    'buildSelectOptionDescriptor',
    'buildBooleanOptionDescriptor',
    'getClaudeModelCapabilities',
    'getModelSelectionStringOptionValue',
    'getModelSelectionBooleanOptionValue',
    'resolveClaudeEffort',
    `${bundle}\nreturn { CATALOG, resolveClaudeApiModelId, allModels, versionModels, pendingModels, getClaudeModelCapabilities, selectedClaudeContextWindow, buildTextSettings, buildAgentSettings, buildAgentEnvironment, parseRateTable };`,
  );
  return factory(
    (value) => value,
    (value) => ({ type: 'select', ...value }),
    (value) => ({ type: 'boolean', ...value }),
    () => ({}),
    (selection, id) => selection.options?.find((option) => option.id === id)?.value,
    (selection, id) => selection.options?.find((option) => option.id === id)?.value,
    (_caps, effort) => effort,
  );
}

function unpatchedBundleFixtureWithNativeRatePriority() {
  const legacyRateBlock = [
    'function parseRateTable(document) {',
    '\tconst table = new Map();',
    '\tif (typeof document !== "object" || document === null) return table;',
    '\tfor (const [name, raw] of Object.entries(document)) {',
    '\t\tif (typeof raw !== "object" || raw === null) continue;',
    '\t\tconst entry = raw;',
    '\t\tconst input = finiteNumber(entry.input_cost_per_token);',
    '\t\tconst output = finiteNumber(entry.output_cost_per_token);',
    '\t\tif (input === null || output === null) continue;',
    '\t\ttable.set(normalizeModelName(name), {',
    '\t\t\tinputCostPerToken: input,',
    '\t\t\toutputCostPerToken: output,',
    '\t\t\tcacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,',
    '\t\t\tcacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input',
    '\t\t});',
    '\t}',
    '\treturn table;',
    '}',
  ].join('\n');
  const nativeRateBlock = [
    'function parseRateTable(document) {',
    '\tconst table = new Map();',
    '\tif (typeof document !== "object" || document === null) return table;',
    '\tfor (const [name, raw] of Object.entries(document)) {',
    '\t\tif (typeof raw !== "object" || raw === null) continue;',
    '\t\tconst entry = raw;',
    '\t\tconst input = finiteNumber(entry.input_cost_per_token);',
    '\t\tconst output = finiteNumber(entry.output_cost_per_token);',
    '\t\tif (input === null || output === null) continue;',
    '\t\tconst key = normalizeRateKey(name);',
    '\t\tif (key.length === 0) continue;',
    '\t\ttable.set(key, {',
    '\t\t\tinputCostPerToken: input,',
    '\t\t\toutputCostPerToken: output,',
    '\t\t\tcacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,',
    '\t\t\tcacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input',
    '\t\t});',
    '\t}',
    '\tconst aliasCandidates = new Map();',
    '\tfor (const [key, rate] of table) {',
    '\t\tconst alias = bareModelName(key);',
    '\t\tif (alias.length === 0 || alias === key || table.has(alias)) continue;',
    '\t\tconst held = aliasCandidates.get(alias);',
    '\t\tif (held === undefined) aliasCandidates.set(alias, rate);',
    '\t\telse if (held !== null && !sameRate(held, rate)) aliasCandidates.set(alias, null);',
    '\t}',
    '\tfor (const [alias, rate] of aliasCandidates) if (rate !== null) table.set(alias, rate);',
    '\treturn table;',
    '}',
    'function normalizeRateKey(model) { return model.trim().toLowerCase(); }',
    'function bareModelName(model) { return model.slice(model.lastIndexOf("/") + 1); }',
    'function sameRate(a, b) { return JSON.stringify(a) === JSON.stringify(b); }',
  ].join('\n');
  return unpatchedBundleFixture().replace(legacyRateBlock, nativeRateBlock);
}

test('canonical model rates beat provider-prefixed aliases with the same normalized name', () => {
  const { parseRateTable } = executePatchedFixture();
  const table = parseRateTable({
    'azure_ai/claude-fable-5': {
      input_cost_per_token: 10e-6,
      cache_read_input_token_cost: 10e-6,
      output_cost_per_token: 50e-6,
    },
    'claude-fable-5': {
      input_cost_per_token: 10e-6,
      cache_read_input_token_cost: 1e-6,
      cache_creation_input_token_cost: 12.5e-6,
      output_cost_per_token: 50e-6,
    },
    'deepinfra/anthropic/claude-fable-5': {
      input_cost_per_token: 10e-6,
      cache_read_input_token_cost: 10e-6,
      cache_creation_input_token_cost: 10e-6,
      output_cost_per_token: 50e-6,
    },
  });

  assert.deepEqual(table.get('claude-fable-5'), {
    inputCostPerToken: 10e-6,
    outputCostPerToken: 50e-6,
    cacheReadCostPerToken: 1e-6,
    cacheCreationCostPerToken: 12.5e-6,
  });
});

test('usage rate patch accepts a bundler-suffixed finite number helper', () => {
  const suffixed = unpatchedBundleFixture().replaceAll('finiteNumber(', 'finiteNumber$1(');
  const result = patchBundle(suffixed);

  assert.equal(result.status, 'patched');
  assert.match(result.bundle, /cacheReadCostPerToken: finiteNumber\$1\(/);
  assert.equal(patchBundle(result.bundle).status, 'already-patched');
});

test('usage rate patch preserves the native v0.0.37 qualified-key pricing implementation', () => {
  const result = patchBundle(unpatchedBundleFixtureWithNativeRatePriority());

  assert.equal(result.status, 'patched');
  assert.match(result.bundle, /\/\* t3-patch:canonical-usage-rate-priority \*\/[\r\n]+function parseRateTable/);
  assert.match(result.bundle, /const key = normalizeRateKey\(name\);/);
  assert.match(result.bundle, /const aliasCandidates = new Map\(\);/);
  assert.match(result.bundle, /if \(alias\.length === 0 \|\| alias === key \|\| table\.has\(alias\)\) continue;/);
  assert.equal(patchBundle(result.bundle).status, 'already-patched');
});

function catalogModel(catalog, slug) {
  return catalog.find((model) => model.slug === slug);
}

test('patch exposes the approved four-model option profiles', () => {
  const { CATALOG } = executePatchedFixture();
  const expected = {
    'claude-fable-5': { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', fast: false },
    'claude-opus-5': { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', fast: false },
    'claude-sonnet-5': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', fast: true },
    'claude-haiku-4-5': { efforts: ['xhigh', 'max'], defaultEffort: 'xhigh', fast: true },
  };

  for (const [slug, profile] of Object.entries(expected)) {
    const model = catalogModel(CATALOG, slug);
    const descriptors = model.capabilities.optionDescriptors;
    const effort = descriptors.find((descriptor) => descriptor.id === 'effort');
    const context = descriptors.find((descriptor) => descriptor.id === 'contextWindow');
    assert.deepEqual(effort.options.map((option) => option.value), profile.efforts, slug);
    assert.equal(effort.options.find((option) => option.isDefault)?.value, profile.defaultEffort, slug);
    assert.equal(descriptors.some((descriptor) => descriptor.id === 'fastMode'), profile.fast, slug);
    assert.deepEqual(context.options, [
      { value: 'default', label: '260k', isDefault: true },
      { value: '1m', label: '1M' },
    ], slug);
    assert.equal(runtimeContextWindow(slug, 'default'), 260000, slug);
    assert.equal(runtimeContextWindow(slug, '1m'), 1000000, slug);
  }
});

function runtimeContextWindow(model, contextWindow) {
  return executePatchedFixture().selectedClaudeContextWindow({
    model,
    options: [{ id: 'contextWindow', value: contextWindow }],
  });
}

test('hybrid models compact at 260k by default and 1M only when selected', () => {
  const runtime = executePatchedFixture();
  for (const model of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    assert.deepEqual(runtime.buildTextSettings({ model, options: [] }), { autoCompactWindow: 260000 }, model);
    assert.deepEqual(runtime.buildAgentSettings({ model, options: [] }), { autoCompactWindow: 260000 }, model);
    const selected = { model, options: [{ id: 'contextWindow', value: '1m' }] };
    assert.deepEqual(runtime.buildTextSettings(selected), { autoCompactWindow: 900000 }, model);
    assert.deepEqual(runtime.buildAgentSettings(selected), { autoCompactWindow: 900000 }, model);
  }
});

test('patch carries effort and fast mode while fixing hybrid slots to the 1m carrier', () => {
  const { resolveClaudeApiModelId } = executePatchedFixture();
  assert.equal(resolveClaudeApiModelId({
    model: 'claude-sonnet-5',
    options: [
      { id: 'contextWindow', value: '1m' },
      { id: 'effort', value: 'xhigh' },
      { id: 'fastMode', value: true },
    ],
  }), 'claude-sonnet-5[1m][effort=xhigh][fast=true]');
  assert.equal(resolveClaudeApiModelId({
    model: 'claude-haiku-4-5',
    options: [
      { id: 'contextWindow', value: '1m' },
      { id: 'effort', value: 'max' },
      { id: 'fastMode', value: false },
    ],
  }), 'claude-haiku-4-5[1m][effort=max]');
  assert.equal(resolveClaudeApiModelId({
    model: 'claude-opus-5',
    options: [
      { id: 'contextWindow', value: '1m' },
      { id: 'effort', value: 'high' },
      { id: 'fastMode', value: true },
    ],
  }), 'claude-opus-5[1m][effort=high]');
  assert.equal(resolveClaudeApiModelId({
    model: 'claude-sonnet-4-6',
    options: [{ id: 'contextWindow', value: '1m' }],
  }), 'claude-sonnet-4-6[1m]');
});

test('patch reserves Qwen output space by compacting its 131k window at 95k', () => {
  const runtime = executePatchedFixture();
  for (const models of [runtime.allModels, runtime.versionModels, runtime.pendingModels]) {
    const qwen = catalogModel(models, 'qwen3.8-27b');
    assert.equal(qwen.name, 'Qwen 3.8 27B (VPN, 131k)');
    assert.equal(qwen.isCustom, true);
    const effort = qwen.capabilities.optionDescriptors.find((descriptor) => descriptor.id === 'effort');
    assert.deepEqual(effort.options.map((option) => option.value), ['low', 'medium', 'xhigh']);
    assert.equal(effort.options.find((option) => option.isDefault)?.value, 'xhigh');
    const context = qwen.capabilities.optionDescriptors.find((descriptor) => descriptor.id === 'contextWindow');
    assert.deepEqual(context.options, [{ value: '131k', label: '131k', isDefault: true }]);
  }
  assert.equal(runtime.getClaudeModelCapabilities('qwen3.8-27b').optionDescriptors[0].id, 'effort');
  assert.equal(runtime.resolveClaudeApiModelId({
    model: 'qwen3.8-27b',
    options: [{ id: 'effort', value: 'medium' }],
  }), 'qwen3.8-27b[effort=medium]');
  assert.equal(runtime.selectedClaudeContextWindow({ model: 'qwen3.8-27b', options: [] }), 131072);
  assert.deepEqual(runtime.buildTextSettings({ model: 'qwen3.8-27b' }), { autoCompactWindow: 95000 });
  assert.deepEqual(runtime.buildAgentSettings({ model: 'qwen3.8-27b' }), { autoCompactWindow: 95000 });
  assert.deepEqual(runtime.buildAgentSettings({ model: 'claude-opus-5' }), { autoCompactWindow: 260000 });
});

test('Qwen gets a private 131k process environment and switching models restores the base environment', () => {
  const runtime = executePatchedFixture();
  const baseEnvironment = {
    PATH: 'C:\\Windows',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '260000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '260000',
  };

  const qwenEnvironment = runtime.buildAgentEnvironment(
    { model: 'qwen3.8-27b' },
    baseEnvironment,
  );
  assert.notEqual(qwenEnvironment, baseEnvironment);
  assert.deepEqual(qwenEnvironment, {
    PATH: 'C:\\Windows',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '131072',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '95000',
  });

  const solEnvironment = runtime.buildAgentEnvironment(
    { model: 'claude-sonnet-5' },
    baseEnvironment,
  );
  assert.equal(solEnvironment, baseEnvironment);
  assert.equal(solEnvironment.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '260000');
  assert.equal(solEnvironment.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '260000');
  assert.equal(baseEnvironment.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '260000');
  assert.equal(baseEnvironment.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '260000');
});

test('Qwen context environment patch accepts the legacy WSL query options anchor', () => {
  const legacyBundle = unpatchedBundleFixture().replace(
    '\t\tsupportedDialogKinds: ["resume_return"],\n\t\tenv: claudeEnvironment,',
    '\t\tcanUseTool,\n\t\tenv: claudeEnvironment,',
  );

  const { bundle } = patchBundle(legacyBundle);
  assert.match(bundle, /canUseTool,\r?\n\s*env: claudeEnvironmentForModel\(modelSelection, claudeEnvironment\),/);
});

test('subagent display config shows the routed Luna model while preserving xhigh', () => {
  withAgentDirs(({ projectDir, homeDir }) => {
    writeAgent(homeDir, 'luna-worker.md', 'name: luna-worker\nmodel: haiku\neffort: xhigh');
    assert.deepEqual(resolveSubagentDisplayConfig({
      subagentType: 'luna-worker',
      projectDir,
      homeDir,
      sessionModel: 'claude-fable-5',
      sessionEffort: 'medium',
      launchInput: {},
    }), { model: 'gpt-5.6-luna', effort: 'xhigh' });
  });
});

test('subagent display config translates Sol carriers without renaming native Claude models', () => {
  withAgentDirs(({ projectDir, homeDir }) => {
    writeAgent(homeDir, 'sol-worker.md', 'model: sonnet\neffort: medium');
    assert.deepEqual(resolveSubagentDisplayConfig({
      subagentType: 'sol-worker', projectDir, homeDir,
      sessionModel: 'claude-fable-5', sessionEffort: 'high', launchInput: {},
    }), { model: 'gpt-5.6-sol', effort: 'medium' });
    assert.deepEqual(resolveSubagentDisplayConfig({
      subagentType: 'missing', projectDir, homeDir,
      sessionModel: 'claude-sonnet-5[1m][effort=high]', sessionEffort: 'high', launchInput: {},
    }), { model: 'gpt-5.6-sol', effort: 'high' });
    assert.deepEqual(resolveSubagentDisplayConfig({
      subagentType: 'missing', projectDir, homeDir,
      sessionModel: 'claude-opus-5', sessionEffort: 'medium', launchInput: {},
    }), { model: 'claude-opus-5', effort: 'medium' });
  });
});

test('explicit launch overrides beat agent frontmatter', () => {
  withAgentDirs(({ projectDir, homeDir }) => {
    writeAgent(homeDir, 'luna-worker.md', 'model: haiku\neffort: xhigh');
    assert.deepEqual(resolveSubagentDisplayConfig({
      subagentType: 'luna-worker',
      projectDir,
      homeDir,
      sessionModel: 'claude-fable-5',
      sessionEffort: 'medium',
      launchInput: { model: 'gpt-explicit', effort: 'high' },
    }), { model: 'gpt-explicit', effort: 'high' });
  });
});

test('project agent frontmatter takes precedence over user frontmatter', () => {
  withAgentDirs(({ projectDir, homeDir }) => {
    writeAgent(homeDir, 'luna-worker.md', 'model: haiku\neffort: high');
    writeAgent(projectDir, 'luna-worker.md', 'model: haiku\neffort: xhigh');
    assert.equal(resolveSubagentDisplayConfig({
      subagentType: 'luna-worker', projectDir, homeDir,
      sessionModel: 'claude-fable-5', sessionEffort: 'medium', launchInput: {},
    }).effort, 'xhigh');
  });
});

test('unknown, unsafe, or malformed agent config falls back to the session', () => {
  withAgentDirs(({ projectDir, homeDir }) => {
    fs.writeFileSync(path.join(projectDir, '.claude', 'agents', 'broken.md'), '---\nmodel: haiku\neffort: xhigh\n', 'utf8');
    const fallback = { model: 'claude-fable-5', effort: 'medium' };
    for (const subagentType of ['missing', '../luna-worker', 'broken']) {
      assert.deepEqual(resolveSubagentDisplayConfig({
        subagentType, projectDir, homeDir,
        sessionModel: fallback.model, sessionEffort: fallback.effort, launchInput: {},
      }), fallback);
    }
  });
});

test('inherit model and invalid effort use session fallbacks independently', () => {
  withAgentDirs(({ projectDir, homeDir }) => {
    writeAgent(homeDir, 'custom.md', 'model: inherit\neffort: impossible');
    assert.deepEqual(resolveSubagentDisplayConfig({
      subagentType: 'custom', projectDir, homeDir,
      sessionModel: 'claude-fable-5', sessionEffort: 'medium', launchInput: {},
    }), { model: 'claude-fable-5', effort: 'medium' });
  });
});

test('subagent metadata patch is present and idempotent', () => {
  const first = patchBundle(unpatchedBundleFixture());
  assert.equal(first.status, 'patched');
  assert.match(first.bundle, /t3-patch:subagent-frontmatter-resolve/);
  assert.match(first.bundle, /t3-patch:subagent-model-display-aliases/);
  assert.match(first.bundle, /resolveSubagentDisplayConfig/);
  assert.equal(patchBundle(first.bundle).status, 'already-patched');
});

test('check-only inspection never mutates the target file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-picker-check-'));
  try {
    const file = path.join(root, 'bin.mjs');
    const original = unpatchedBundleFixture();
    fs.writeFileSync(file, original);
    const before = fs.readFileSync(file);

    assert.equal(checkTarget({ kind: 'file', file }).status, 'patch-required');
    assert.deepEqual(fs.readFileSync(file), before);

    fs.writeFileSync(file, patchBundle(original).bundle);
    const patched = fs.readFileSync(file);
    assert.equal(checkTarget({ kind: 'file', file }).status, 'already-patched');
    assert.deepEqual(fs.readFileSync(file), patched);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subagent metadata patch refuses a bundle without the exact launch anchor', () => {
  const withoutAnchor = unpatchedBundleFixture().replace(
    '\t\t\tconst rawLaunchEffort = launchInput?.effort;',
    '\t\t\tconst differentRuntimeShape = launchInput?.effort;',
  );
  assert.throws(
    () => patchBundle(withoutAnchor),
    /Expected one Claude subagent launch metadata block; found 0/,
  );
});

test('subagent metadata patch accepts the T3 0.0.34 buffered-model launch block', () => {
  const buffered = unpatchedBundleFixture().replace(
    '\t\t\tconst model = trimmedString(launchInput?.model) ?? trimmedString(context.session.model ?? void 0);',
    [
      '\t\t\tconst toolUseId = message.tool_use_id;',
      '\t\t\tconst bufferedModel = toolUseId ? context.pendingTaskModels.get(toolUseId) : void 0;',
      '\t\t\tif (toolUseId) context.pendingTaskModels.delete(toolUseId);',
      '\t\t\tconst model = bufferedModel ?? trimmedString(launchInput?.model) ?? trimmedString(context.session.model ?? void 0);',
    ].join('\n'),
  );
  const result = patchBundle(buffered);
  assert.equal(result.status, 'patched');
  assert.match(result.bundle, /bufferedModel \? \{ \.\.\.launchInput, model: bufferedModel \} : launchInput/);
  assert.doesNotMatch(result.bundle, /const rawLaunchEffort = launchInput\?\.effort/);
});

test('default target resolves the T3 0.0.34 server.asar layout', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 't3-resources-'));
  try {
    const archive = path.join(resources, 'server.asar');
    fs.writeFileSync(archive, 'archive fixture');
    assert.deepEqual(resolveDefaultTarget(resources), {
      kind: 'asar',
      archive,
      entry: path.join('apps', 'server', 'dist', 'bin.mjs'),
    });
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('default target keeps compatibility with the legacy unpacked layout', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 't3-resources-'));
  try {
    const bundle = path.join(resources, 'app.asar.unpacked', 'apps', 'server', 'dist', 'bin.mjs');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, 'legacy bundle');
    fs.writeFileSync(path.join(resources, 'server.asar'), 'archive fixture');
    assert.deepEqual(resolveDefaultTarget(resources), { kind: 'file', file: bundle });
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

test('patches and verifies a server.asar archive while preserving a backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-asar-patch-'));
  try {
    const source = path.join(root, 'source');
    const entry = path.join('apps', 'server', 'dist', 'bin.mjs');
    const bundle = path.join(source, entry);
    const archive = path.join(root, 'server.asar');
    const extracted = path.join(root, 'verified');
    const backups = path.join(root, 'backups');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, unpatchedBundleFixture(), 'utf8');
    execFileSync(process.execPath, [ASAR_CLI, 'pack', source, archive]);

    const result = patchAsarTarget({ kind: 'asar', archive, entry }, backups, ASAR_CLI);
    assert.equal(result.status, 'patched');
    assert.ok(fs.existsSync(result.backup));

    execFileSync(process.execPath, [ASAR_CLI, 'extract', archive, extracted]);
    const patched = fs.readFileSync(path.join(extracted, entry), 'utf8');
    assert.match(patched, /t3-patch:subagent-frontmatter-resolve/);
    assert.equal(patchBundle(patched).status, 'already-patched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('patches a copied archive without requiring its unpacked native sidecar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-asar-sidecar-'));
  try {
    const source = path.join(root, 'source');
    const entry = path.join('apps', 'server', 'dist', 'bin.mjs');
    const bundle = path.join(source, entry);
    const nativeFile = path.join(source, 'node_modules', 'native.node');
    const originalArchive = path.join(root, 'original.asar');
    const detached = path.join(root, 'detached', 'server.asar');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(bundle, unpatchedBundleFixture(), 'utf8');
    fs.writeFileSync(nativeFile, 'native sidecar fixture');
    execFileSync(process.execPath, [ASAR_CLI, 'pack', source, originalArchive, '--unpack', 'native.node']);
    fs.mkdirSync(path.dirname(detached), { recursive: true });
    fs.copyFileSync(originalArchive, detached);

    const result = patchAsarTarget({ kind: 'asar', archive: detached, entry }, path.join(root, 'backups'), ASAR_CLI);
    assert.equal(result.status, 'patched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
