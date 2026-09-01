const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const ROUTER_REVISION = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');

const GPT_MODELS = new Map([
  ['claude-sonnet-5', 'gpt-5.6-sol'],
  ['claude-sonnet-5[1m]', 'gpt-5.6-sol'],
  ['claude-haiku-4-5', 'gpt-5.6-luna'],
  ['claude-haiku-4-5[1m]', 'gpt-5.6-luna'],
  ['anthropic/gpt-5.6-sol', 'gpt-5.6-sol'],
  ['anthropic/gpt-5.6-luna', 'gpt-5.6-luna'],
  ['anthropic/gpt-5.3-codex-spark', 'gpt-5.3-codex-spark'],
  ['gpt-5.6-sol', 'gpt-5.6-sol'],
  ['gpt-5.6-luna', 'gpt-5.6-luna'],
  ['gpt-5.3-codex-spark', 'gpt-5.3-codex-spark'],
]);
const QWEN_MODELS = new Map([
  ['qwen3.8-27b', 'qwen3.8-27b'],
]);
const SOL_FALLBACK_ROUTE = Object.freeze({ provider: 'gpt', model: 'gpt-5.6-sol' });
const LUNA_FALLBACK_ROUTE = Object.freeze({ provider: 'gpt', model: 'gpt-5.6-luna' });
const QWEN_FALLBACK_ROUTE = Object.freeze({ provider: 'qwen', model: 'qwen3.8-27b' });
const CLAUDE_MODELS = new Map([
  ['hybrid-fable-5', 'claude-fable-5'],
  ['hybrid-opus-5', 'claude-opus-5'],
  ['claude-fable-5[1m]', 'claude-fable-5'],
  ['claude-opus-5[1m]', 'claude-opus-5'],
]);
const EFFORT_CARRIER_PATTERN = /^(.*)\[effort=(low|medium|high|xhigh|max)\]$/;
const FAST_CARRIER_PATTERN = /^(.*)\[fast=true\]$/;

function classifyModel(model) {
  const fastCarrier = typeof model === 'string' ? model.match(FAST_CARRIER_PATTERN) : null;
  const withoutFastCarrier = fastCarrier?.[1] || model;
  const effortCarrier = typeof withoutFastCarrier === 'string' ? withoutFastCarrier.match(EFFORT_CARRIER_PATTERN) : null;
  const baseModel = effortCarrier?.[1] || withoutFastCarrier;
  const effort = effortCarrier?.[2];
  if (GPT_MODELS.has(baseModel)) {
    return {
      provider: 'gpt',
      model: GPT_MODELS.get(baseModel),
      ...(effort ? { effort } : {}),
      ...(fastCarrier ? { fast: true } : {}),
    };
  }
  if (QWEN_MODELS.has(baseModel)) {
    return { provider: 'qwen', model: QWEN_MODELS.get(baseModel), ...(effort ? { effort } : {}) };
  }
  if (CLAUDE_MODELS.has(baseModel)) {
    return { provider: 'anthropic', model: CLAUDE_MODELS.get(baseModel), ...(effort ? { effort } : {}) };
  }
  if (typeof baseModel === 'string' && (baseModel.startsWith('anthropic/') || baseModel.startsWith('hybrid-'))) {
    throw new Error(`Unsupported hybrid model: ${model}`);
  }
  return { provider: 'anthropic', model: baseModel, ...(effort ? { effort } : {}) };
}

function preparePayload(payload) {
  const route = classifyModel(payload.model);
  const copy = route.provider === 'gpt' ? sanitizeForGpt(payload) : JSON.parse(JSON.stringify(payload));
  const rewriteModels = (value) => {
    if (Array.isArray(value)) return value.map(rewriteModels);
    if (!value || typeof value !== 'object') return value;
    for (const [key, child] of Object.entries(value)) {
      value[key] = key === 'model' && CLAUDE_MODELS.has(child) ? CLAUDE_MODELS.get(child) : rewriteModels(child);
    }
    return value;
  };
  rewriteModels(copy);
  copy.model = route.model;
  if (route.effort) {
    copy.output_config = { ...copy.output_config, effort: route.effort };
  }
  if (route.provider === 'gpt' && route.fast) {
    copy.speed = 'fast';
  }
  return { provider: route.provider, payload: copy };
}

function sanitizeForGpt(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.model = classifyModel(copy.model).model;
  const clean = (value) => {
    if (Array.isArray(value)) {
      return value
        .filter((item) => item?.type !== 'thinking' && item?.type !== 'redacted_thinking')
        .map(clean);
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) value[key] = clean(child);
    }
    return value;
  };
  return clean(copy);
}

function fallbackRoutesFor(provider, model) {
  if (provider === 'anthropic') return [SOL_FALLBACK_ROUTE, LUNA_FALLBACK_ROUTE, QWEN_FALLBACK_ROUTE];
  if (provider === 'gpt' && model === 'gpt-5.6-sol') return [LUNA_FALLBACK_ROUTE, QWEN_FALLBACK_ROUTE];
  if (provider === 'gpt' && model === 'gpt-5.6-luna') return [QWEN_FALLBACK_ROUTE];
  return [];
}

function isTransientFailureStatus(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function upstreamHeaders(incoming, provider, proxyKey) {
  const headers = { ...incoming };
  for (const name of ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-connection']) {
    delete headers[name];
  }
  if (provider === 'gpt') {
    delete headers.authorization;
    delete headers['x-api-key'];
    headers.authorization = `Bearer ${proxyKey}`;
    headers['x-api-key'] = proxyKey;
  }
  if (provider === 'qwen') {
    delete headers.authorization;
    delete headers['x-api-key'];
    delete headers.cookie;
    delete headers['proxy-authorization'];
  }
  return headers;
}

function readProxyKey(configPath) {
  if (process.env.CLI_PROXY_KEY) return process.env.CLI_PROXY_KEY;
  const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^api-keys:\s*$/.test(line));
  if (start < 0) throw new Error(`api-keys block missing in ${configPath}`);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && lines[i].trim()) break;
    const match = lines[i].match(/^\s*-\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/);
    if (match) return match[1];
  }
  throw new Error(`No proxy API key found in ${configPath}`);
}

function writeAuditEvent(auditLog, event) {
  if (!auditLog) return;
  try {
    fs.appendFileSync(auditLog, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
  } catch (error) {
    console.error(`[claude-hybrid-router] audit write failed: ${error.message}`);
  }
}

function countTokensPayload(payload) {
  const allowed = ['model', 'messages', 'system', 'tools', 'tool_choice', 'chat_template_kwargs'];
  return Object.fromEntries(allowed.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
}

function requestGptInputTokens(baseUrl, incomingHeaders, proxyKey, payload) {
  return new Promise((resolve) => {
    const target = new URL('/v1/messages/count_tokens', baseUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(countTokensPayload(payload)));
    const request = transport.request(target, {
      method: 'POST',
      headers: upstreamHeaders(incomingHeaders, 'gpt', proxyKey),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200 || size > 1024 * 1024) return resolve(undefined);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')).input_tokens;
          resolve(typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.setTimeout(2000, () => request.destroy());
    request.on('error', () => resolve(undefined));
    request.end(body);
  });
}

function createMessageStartUsageTransform(inputTokens) {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  const rewriteLine = (line) => {
    if (!line.startsWith('data:')) return line;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type !== 'message_start' || !event.message?.usage) return line;
      const current = event.message.usage.input_tokens;
      if (typeof current === 'number' && current > 0) return line;
      event.message.usage.input_tokens = inputTokens;
      return `data: ${JSON.stringify(event)}`;
    } catch {
      return line;
    }
  };
  const flushLines = (stream, final = false) => {
    const lines = buffered.split('\n');
    buffered = final ? '' : lines.pop();
    const complete = final ? lines : lines;
    for (let index = 0; index < complete.length; index += 1) {
      const line = complete[index];
      const carriageReturn = line.endsWith('\r') ? '\r' : '';
      const content = carriageReturn ? line.slice(0, -1) : line;
      stream.push(`${rewriteLine(content)}${carriageReturn}${index < complete.length - 1 || !final ? '\n' : ''}`);
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffered += decoder.write(chunk);
      flushLines(this);
      callback();
    },
    flush(callback) {
      buffered += decoder.end();
      flushLines(this, true);
      callback();
    },
  });
}

function createServer(options = {}) {
  const anthropicUrl = options.anthropicUrl || process.env.ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
  const gptUrl = options.gptUrl || process.env.CLI_PROXY_URL || 'http://127.0.0.1:18437';
  const qwenUrl = options.qwenUrl || process.env.QWEN_UPSTREAM;
  const configPath = options.configPath || process.env.CLI_PROXY_CONFIG || path.join(os.homedir(), 'bin', 'cliproxyapi', 'config.yaml');
  const proxyKey = options.proxyKey || readProxyKey(configPath);
  const auditLog = options.auditLog ?? process.env.HYBRID_ROUTER_AUDIT_LOG;
  const configuredTimeout = Number(options.upstreamTimeoutMs ?? process.env.HYBRID_ROUTER_UPSTREAM_TIMEOUT_MS ?? 180_000);
  const upstreamTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 180_000;

  return http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        revision: ROUTER_REVISION,
        models: [...new Set([...GPT_MODELS.values(), ...QWEN_MODELS.values()])],
      }));
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) req.destroy(new Error('Request body exceeds 64 MiB'));
      else chunks.push(chunk);
    });
    req.on('error', (error) => {
      if (!res.headersSent) res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }));
    });
    req.on('end', () => {
      try {
        const requestId = crypto.randomUUID();
        let body = Buffer.concat(chunks);
        let provider = 'anthropic';
        let originalPayload;
        let routedModel;
        const routesByModel = /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(req.url || '');
        if (routesByModel) {
          originalPayload = JSON.parse(body.toString('utf8'));
          const prepared = preparePayload(originalPayload);
          provider = prepared.provider;
          routedModel = prepared.payload.model;
          body = Buffer.from(JSON.stringify(prepared.payload));
          writeAuditEvent(auditLog, {
            event: 'route',
            requestId,
            path: req.url,
            sourceModel: originalPayload.model,
            targetProvider: provider,
            targetModel: routedModel,
            effort: prepared.payload.output_config?.effort,
            fastMode: prepared.payload.speed === 'fast',
          });
        }

        const send = async (targetProvider, targetBody, fallbackRoutes = [], targetModel = routedModel) => {
          const base = targetProvider === 'gpt' ? gptUrl : targetProvider === 'qwen' ? qwenUrl : anthropicUrl;
          if (!base) throw new Error('QWEN_UPSTREAM is required for the Qwen route.');
          const target = new URL(req.url || '/', base);
          const transport = target.protocol === 'https:' ? https : http;
          const targetPayload = routesByModel ? JSON.parse(targetBody.toString('utf8')) : undefined;
          const inputTokens = targetProvider === 'gpt' && targetPayload?.stream === true && /^\/v1\/messages(?:\?|$)/.test(req.url || '')
            ? await requestGptInputTokens(gptUrl, req.headers, proxyKey, targetPayload)
            : undefined;
          let attemptSettled = false;
          const retryFallback = () => {
            if (attemptSettled || !originalPayload || fallbackRoutes.length === 0) return false;
            attemptSettled = true;
            const [fallback, ...remainingFallbacks] = fallbackRoutes;
            const fallbackPayload = sanitizeForGpt({ ...originalPayload, model: fallback.model });
            void send(
              fallback.provider,
              Buffer.from(JSON.stringify(fallbackPayload)),
              remainingFallbacks,
              fallbackPayload.model,
            );
            return true;
          };
          const upstream = transport.request(target, {
            method: req.method,
            headers: upstreamHeaders(req.headers, targetProvider, proxyKey),
          }, (upstreamRes) => {
            writeAuditEvent(auditLog, {
              event: 'result',
              requestId,
              targetProvider,
              targetModel,
              statusCode: upstreamRes.statusCode || 502,
            });
            if (isTransientFailureStatus(upstreamRes.statusCode || 502) && retryFallback()) {
              upstreamRes.resume();
              return;
            }
            attemptSettled = true;
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            if (inputTokens !== undefined && String(upstreamRes.headers['content-type'] || '').includes('text/event-stream')) {
              upstreamRes.pipe(createMessageStartUsageTransform(inputTokens)).pipe(res);
            } else {
              upstreamRes.pipe(res);
            }
          });
          upstream.on('error', (error) => {
            writeAuditEvent(auditLog, {
              event: 'error',
              requestId,
              targetProvider,
              targetModel,
              errorCode: error.code,
            });
            if (retryFallback()) return;
            if (res.headersSent) {
              res.destroy(error);
              return;
            }
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: error.message } }));
          });
          upstream.setTimeout(upstreamTimeoutMs, () => {
            const error = new Error(`Upstream request timed out after ${upstreamTimeoutMs} ms`);
            error.code = 'ETIMEDOUT';
            upstream.destroy(error);
          });
          if (targetBody.length) upstream.write(targetBody);
          upstream.end();
        };
        void send(provider, body, fallbackRoutesFor(provider, routedModel), routedModel);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }));
      }
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.HYBRID_ROUTER_PORT || 18438);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`[claude-hybrid-router] listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

module.exports = { classifyModel, preparePayload, sanitizeForGpt, upstreamHeaders, createServer };
