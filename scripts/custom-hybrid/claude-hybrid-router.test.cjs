const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  classifyModel,
  preparePayload,
  sanitizeForGpt,
  upstreamHeaders,
  createServer,
} = require("./claude-hybrid-router.cjs");

test("maps hybrid picker models to the intended upstream models", () => {
  assert.deepEqual(classifyModel("claude-haiku-4-5-20251001"), {
    provider: "gpt",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(classifyModel("claude-sonnet-5-20260801[1m][effort=high]"), {
    provider: "gpt",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  assert.deepEqual(classifyModel("claude-sonnet-4-6-20251117"), {
    provider: "anthropic",
    model: "claude-sonnet-4-6-20251117",
  });
  assert.deepEqual(classifyModel("hybrid-fable-5"), {
    provider: "anthropic",
    model: "claude-fable-5-1",
  });
  assert.deepEqual(classifyModel("hybrid-opus-5"), {
    provider: "anthropic",
    model: "claude-opus-5",
  });
  assert.deepEqual(classifyModel("claude-fable-5-1"), {
    provider: "anthropic",
    model: "claude-fable-5-1",
  });
  assert.deepEqual(classifyModel("claude-fable-5"), {
    provider: "anthropic",
    model: "claude-fable-5",
  });
  assert.deepEqual(classifyModel("claude-opus-5"), {
    provider: "anthropic",
    model: "claude-opus-5",
  });
  assert.deepEqual(classifyModel("claude-fable-5-1[1m][effort=medium]"), {
    provider: "anthropic",
    model: "claude-fable-5-1",
    effort: "medium",
  });
  assert.deepEqual(classifyModel("claude-opus-5[1m][effort=low]"), {
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "low",
  });
  assert.deepEqual(classifyModel("claude-fable-5-1[effort=medium]"), {
    provider: "anthropic",
    model: "claude-fable-5-1",
    effort: "medium",
  });
  assert.deepEqual(classifyModel("claude-opus-5[effort=low]"), {
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "low",
  });
  assert.deepEqual(classifyModel("claude-sonnet-5"), { provider: "gpt", model: "gpt-5.6-sol" });
  assert.deepEqual(classifyModel("claude-sonnet-5[1m]"), { provider: "gpt", model: "gpt-5.6-sol" });
  assert.deepEqual(classifyModel("claude-haiku-4-5"), { provider: "gpt", model: "gpt-5.6-luna" });
  assert.deepEqual(classifyModel("claude-sonnet-5[1m][effort=xhigh]"), {
    provider: "gpt",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
  assert.deepEqual(classifyModel("claude-sonnet-5[1m][effort=xhigh][fast=true]"), {
    provider: "gpt",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    fast: true,
  });
  assert.deepEqual(classifyModel("claude-haiku-4-5[effort=max]"), {
    provider: "gpt",
    model: "gpt-5.6-luna",
    effort: "max",
  });
  assert.deepEqual(classifyModel("anthropic/gpt-5.6-sol"), {
    provider: "gpt",
    model: "gpt-5.6-sol",
  });
  assert.deepEqual(classifyModel("anthropic/gpt-5.6-luna"), {
    provider: "gpt",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(classifyModel("qwen3.8-27b"), { provider: "qwen", model: "qwen3.8-27b" });
  assert.deepEqual(classifyModel("qwen3.8-27b[effort=xhigh]"), {
    provider: "qwen",
    model: "qwen3.8-27b",
    effort: "xhigh",
  });
});

test("routes Qwen reasoning effort through Anthropic output_config", () => {
  assert.deepEqual(
    preparePayload({
      model: "qwen3.8-27b[effort=medium]",
      output_config: { format: { type: "json_schema", schema: {} } },
      messages: [],
    }),
    {
      provider: "qwen",
      payload: {
        model: "qwen3.8-27b",
        output_config: {
          format: { type: "json_schema", schema: {} },
          effort: "medium",
        },
        messages: [],
      },
    },
  );
});

test("routes T3 Claude carrier slots to GPT while preserving effort", () => {
  assert.deepEqual(
    preparePayload({
      model: "claude-sonnet-5[1m]",
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
      messages: [],
    }),
    {
      provider: "gpt",
      payload: {
        model: "gpt-5.6-sol",
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
        messages: [],
      },
    },
  );
  assert.deepEqual(
    preparePayload({
      model: "claude-haiku-4-5[effort=max][fast=true]",
      messages: [],
    }),
    {
      provider: "gpt",
      payload: {
        model: "gpt-5.6-luna",
        output_config: { effort: "max" },
        speed: "fast",
        messages: [],
      },
    },
  );
});

test("rewrites Claude aliases before forwarding to Anthropic", () => {
  assert.deepEqual(
    preparePayload({
      model: "hybrid-fable-5",
      messages: [],
      tools: [{ name: "Agent", model: "hybrid-opus-5" }],
    }),
    {
      provider: "anthropic",
      payload: {
        model: "claude-fable-5-1",
        messages: [],
        tools: [{ name: "Agent", model: "claude-opus-5" }],
      },
    },
  );
  assert.deepEqual(
    preparePayload({
      model: "claude-fable-5-1[1m][effort=medium]",
      messages: [],
    }),
    {
      provider: "anthropic",
      payload: {
        model: "claude-fable-5-1",
        output_config: { effort: "medium" },
        messages: [],
      },
    },
  );
});

test("rejects unknown synthetic hybrid models instead of silently misrouting", () => {
  assert.throws(() => classifyModel("anthropic/gpt-unknown"), /unsupported hybrid model/i);
});

test("routes Astra aliases to GPT and preserves the requested effort", () => {
  for (const model of ["gpt-6-astra", "anthropic/gpt-6-astra"]) {
    assert.deepEqual(classifyModel(`${model}[effort=medium]`), {
      provider: "gpt",
      model: "gpt-6-astra",
      effort: "medium",
    });
  }
});

test("model alias rewriting preserves tool input and schema data", () => {
  const input = { model: "hybrid-opus-5", nested: { model: "hybrid-fable-5" } };
  const payload = {
    model: "hybrid-fable-5",
    messages: [{ role: "assistant", content: [{ type: "tool_use", name: "save", input }] }],
    tools: [{ name: "save", input_schema: { examples: [input] } }],
  };
  const result = preparePayload(payload).payload;
  assert.deepEqual(result.messages, payload.messages);
  assert.deepEqual(result.tools, payload.tools);
});

test("GPT sanitization preserves tool input records that look like thinking blocks", () => {
  const input = {
    records: [
      { type: "thinking", text: "user data" },
      { type: "redacted_thinking", data: "user data" },
    ],
  };
  const payload = {
    model: "anthropic/gpt-5.6-sol",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "save", input }] },
    ],
  };
  assert.deepEqual(sanitizeForGpt(payload).messages[0].content[0].input, input);
});

test("router rejects absolute request targets instead of forwarding to another origin", async () => {
  const server = createServer({ proxyKey: "test-only" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const target of ["http://127.0.0.1:1/leak", "//127.0.0.1:1/leak", "/\\127.0.0.1:1/leak"]) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.address().port, path: target },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 400);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("removes signed Claude thinking blocks before a GPT request", () => {
  const payload = {
    model: "anthropic/gpt-5.6-sol",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "signed" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "kept" },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ],
      },
    ],
  };

  assert.deepEqual(sanitizeForGpt(payload), {
    model: "gpt-5.6-sol",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "kept" },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ],
      },
    ],
  });
  assert.equal(payload.model, "anthropic/gpt-5.6-sol");
});

test("keeps Claude OAuth headers native and isolates GPT authentication", () => {
  const incoming = {
    host: "127.0.0.1:8318",
    connection: "keep-alive",
    "content-length": "123",
    authorization: "Bearer claude-oauth",
    "x-api-key": "claude-key",
    "anthropic-version": "2023-06-01",
  };

  const claude = upstreamHeaders(incoming, "anthropic", "local-key");
  assert.equal(claude.authorization, "Bearer claude-oauth");
  assert.equal(claude["x-api-key"], "claude-key");
  assert.equal(claude.host, undefined);
  assert.equal(claude["content-length"], undefined);

  const gpt = upstreamHeaders(incoming, "gpt", "local-key");
  assert.equal(gpt.authorization, "Bearer local-key");
  assert.equal(gpt["x-api-key"], "local-key");
  assert.equal(gpt["anthropic-version"], "2023-06-01");

  const qwen = upstreamHeaders(incoming, "qwen", "local-key");
  assert.equal(qwen.authorization, undefined);
  assert.equal(qwen["x-api-key"], undefined);
  assert.equal(qwen["anthropic-version"], "2023-06-01");
});

test("health reports the running router revision", async () => {
  const router = createServer({ proxyKey: "local-key" });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/healthz`);
    assert.equal(response.status, 200);
    const health = await response.json();
    const expectedRevision = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(__dirname, "claude-hybrid-router.cjs")))
      .digest("hex");
    assert.equal(health.revision, expectedRevision);
  } finally {
    await close(router);
  }
});

test("routes Qwen to its VPN upstream without leaking Claude credentials", async () => {
  let qwenRequest;
  const qwen = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      qwenRequest = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url.endsWith("/count_tokens")
            ? { input_tokens: 10 }
            : { type: "message", content: [{ type: "text", text: "qwen-ok" }] },
        ),
      );
    });
  });
  const qwenPort = await listen(qwen);
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: "http://127.0.0.1:1",
    qwenUrl: `http://127.0.0.1:${qwenPort}`,
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer claude-oauth",
        "x-api-key": "claude-key",
      },
      body: JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: "work" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "qwen-ok");
    assert.equal(qwenRequest.body.model, "qwen3.8-27b");
    assert.equal(qwenRequest.headers.authorization, undefined);
    assert.equal(qwenRequest.headers["x-api-key"], undefined);
  } finally {
    await Promise.all([close(router), close(qwen)]);
  }
});

test("reports a missing Qwen upstream without terminating the router", async () => {
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: "http://127.0.0.1:1",
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.8-27b", messages: [] }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /QWEN_UPSTREAM/);

    const health = await fetch(`http://127.0.0.1:${routerPort}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await close(router);
  }
});

test("serves Claude, Codex, and Qwen requests concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const upstream = () =>
    http.createServer((req, res) => {
      req.resume();
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            req.url.endsWith("/count_tokens")
              ? { input_tokens: 10 }
              : { type: "message", content: [] },
          ),
        );
      }, 40);
    });
  const anthropic = upstream();
  const gpt = upstream();
  const qwen = upstream();
  const [anthropicPort, gptPort, qwenPort] = await Promise.all([
    listen(anthropic),
    listen(gpt),
    listen(qwen),
  ]);
  const router = createServer({
    anthropicUrl: `http://127.0.0.1:${anthropicPort}`,
    gptUrl: `http://127.0.0.1:${gptPort}`,
    qwenUrl: `http://127.0.0.1:${qwenPort}`,
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const request = (model) =>
      fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [] }),
      });
    const responses = await Promise.all([
      request("claude-fable-5-1"),
      request("claude-sonnet-5"),
      request("qwen3.8-27b"),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200],
    );
    assert.equal(maxActive, 3);
  } finally {
    await Promise.all([close(router), close(anthropic), close(gpt), close(qwen)]);
  }
});

test("writes a privacy-safe audit of the routed model and upstream result", async () => {
  const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-router-audit-"));
  const auditLog = path.join(auditDirectory, "audit.ndjson");
  const gpt = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] }));
  });
  const gptPort = await listen(gpt);
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: `http://127.0.0.1:${gptPort}`,
    proxyKey: "local-key",
    auditLog,
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5[1m][effort=xhigh][fast=true]",
        messages: [{ role: "user", content: "private prompt must not be logged" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const rawAudit = fs.readFileSync(auditLog, "utf8");
    const events = rawAudit
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.deepEqual(
      {
        event: events[0].event,
        sourceModel: events[0].sourceModel,
        targetProvider: events[0].targetProvider,
        targetModel: events[0].targetModel,
        effort: events[0].effort,
        fastMode: events[0].fastMode,
      },
      {
        event: "route",
        sourceModel: "claude-sonnet-5[1m][effort=xhigh][fast=true]",
        targetProvider: "gpt",
        targetModel: "gpt-5.6-sol",
        effort: "xhigh",
        fastMode: true,
      },
    );
    assert.equal(events[1].event, "result");
    assert.equal(events[1].targetModel, "gpt-5.6-sol");
    assert.equal(events[1].statusCode, 200);
    assert.equal(events[0].requestId, events[1].requestId);
    assert.doesNotMatch(rawAudit, /private prompt|local-key/);
  } finally {
    await Promise.all([close(router), close(gpt)]);
  }
});

test("fills streaming message_start input usage without replacing the routed GPT model", async () => {
  const requests = [];
  const gpt = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ url: req.url, body });
      if (req.url === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1234 }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\n");
      res.write(
        `data: ${JSON.stringify({
          type: "message_start",
          message: {
            type: "message",
            model: "gpt-5.6-luna",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`,
      );
      res.write("event: message_delta\n");
      res.write(
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 1234, output_tokens: 7 },
        })}\n\n`,
      );
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  const gptPort = await listen(gpt);
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: `http://127.0.0.1:${gptPort}`,
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5[1m][effort=xhigh]",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "work" }],
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));

    assert.equal(events[0].type, "message_start");
    assert.equal(events[0].message.model, "gpt-5.6-luna");
    assert.deepEqual(events[0].message.usage, { input_tokens: 1234, output_tokens: 0 });
    assert.deepEqual(events[1].usage, { input_tokens: 1234, output_tokens: 7 });
    assert.deepEqual(
      requests.map((request) => request.url),
      ["/v1/messages/count_tokens", "/v1/messages?beta=true"],
    );
    assert.deepEqual(requests[0].body, {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "work" }],
    });
  } finally {
    await Promise.all([close(router), close(gpt)]);
  }
});

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("falls back from Anthropic usage limit to Sol through the GPT proxy", async () => {
  let gptRequest;
  const anthropic = http.createServer((req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Usage limit reached" },
      }),
    );
  });
  const gpt = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      gptRequest = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "message", content: [{ type: "text", text: "fallback-ok" }] }),
      );
    });
  });
  const anthropicPort = await listen(anthropic);
  const gptPort = await listen(gpt);
  const router = createServer({
    anthropicUrl: `http://127.0.0.1:${anthropicPort}`,
    gptUrl: `http://127.0.0.1:${gptPort}`,
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer claude-oauth" },
      body: JSON.stringify({
        model: "hybrid-fable-5",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", signature: "signed" },
              { type: "text", text: "kept" },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "fallback-ok");
    assert.equal(gptRequest.body.model, "gpt-5.6-sol");
    assert.deepEqual(gptRequest.body.messages[0].content, [{ type: "text", text: "kept" }]);
    assert.equal(gptRequest.headers.authorization, "Bearer local-key");
  } finally {
    await Promise.all([close(router), close(anthropic), close(gpt)]);
  }
});

test("falls back from direct Sol through Luna to Qwen on transient errors", async () => {
  const gptModels = [];
  let qwenRequest;
  const gpt = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      gptModels.push(body.model);
      if (body.model === "gpt-5.6-sol") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Sol unavailable" },
          }),
        );
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "upstream_error", message: "Luna unavailable" },
        }),
      );
    });
  });
  const qwen = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      qwenRequest = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url.endsWith("/count_tokens")
            ? { input_tokens: 10 }
            : { type: "message", content: [{ type: "text", text: "qwen-ok" }] },
        ),
      );
    });
  });
  const gptPort = await listen(gpt);
  const qwenPort = await listen(qwen);
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: `http://127.0.0.1:${gptPort}`,
    qwenUrl: `http://127.0.0.1:${qwenPort}`,
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer claude-oauth" },
      body: JSON.stringify({
        model: "anthropic/gpt-5.6-sol",
        messages: [{ role: "user", content: "work" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "qwen-ok");
    assert.deepEqual(gptModels, ["gpt-5.6-sol", "gpt-5.6-luna"]);
    assert.equal(qwenRequest.body.model, "qwen3.8-27b");
    assert.equal(qwenRequest.headers.authorization, undefined);
    assert.equal(qwenRequest.headers["x-api-key"], undefined);
  } finally {
    await Promise.all([close(router), close(gpt), close(qwen)]);
  }
});

test("falls back from an unresponsive Sol request to Luna after the upstream timeout", async () => {
  const gptModels = [];
  const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-router-timeout-audit-"));
  const auditLog = path.join(auditDirectory, "audit.ndjson");
  const gpt = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      gptModels.push(body.model);
      if (body.model === "gpt-5.6-sol") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ type: "message", content: [{ type: "text", text: "sol-too-late" }] }),
          );
        }, 100);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "luna-ok" }] }));
    });
  });
  const gptPort = await listen(gpt);
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: `http://127.0.0.1:${gptPort}`,
    qwenUrl: "http://127.0.0.1:1",
    proxyKey: "local-key",
    auditLog,
    upstreamTimeoutMs: 25,
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5.6-sol",
        messages: [{ role: "user", content: "work" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "luna-ok");
    assert.deepEqual(gptModels, ["gpt-5.6-sol", "gpt-5.6-luna"]);
    const events = fs
      .readFileSync(auditLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events
        .filter((event) => event.event !== "route")
        .map((event) => ({
          event: event.event,
          targetModel: event.targetModel,
          willRetry: event.willRetry,
        })),
      [
        { event: "error", targetModel: "gpt-5.6-sol", willRetry: true },
        { event: "result", targetModel: "gpt-5.6-luna", willRetry: false },
      ],
    );
  } finally {
    await Promise.all([close(router), close(gpt)]);
  }
});

test("marks the exhausted transient result as terminal in the audit", async () => {
  const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-router-exhausted-audit-"));
  const auditLog = path.join(auditDirectory, "audit.ndjson");
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "unavailable" },
        }),
      );
    });
  });
  const upstreamPort = await listen(upstream);
  const router = createServer({
    anthropicUrl: `http://127.0.0.1:${upstreamPort}`,
    gptUrl: `http://127.0.0.1:${upstreamPort}`,
    qwenUrl: `http://127.0.0.1:${upstreamPort}`,
    proxyKey: "local-key",
    auditLog,
  });
  const routerPort = await listen(router);

  try {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "hybrid-fable-5",
        messages: [{ role: "user", content: "work" }],
      }),
    });
    assert.equal(response.status, 503);
    await response.text();
    const events = fs
      .readFileSync(auditLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const results = events.filter((event) => event.event === "result");
    assert.equal(results.at(-1).targetModel, "qwen3.8-27b");
    assert.equal(results.at(-1).willRetry, false);
  } finally {
    await Promise.all([close(router), close(upstream)]);
  }
});

test("passes through compressed GPT SSE and requests identity encoding for count and generation", async () => {
  const requests = [];
  const compressedSse = zlib.gzipSync(
    Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n',
    ),
  );
  const gpt = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url, acceptEncoding: req.headers["accept-encoding"] });
      if (req.url === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1234 }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "content-length": String(compressedSse.length),
      });
      res.end(compressedSse);
    });
  });
  const gptPort = await listen(gpt);
  const router = createServer({
    anthropicUrl: "http://127.0.0.1:1",
    gptUrl: `http://127.0.0.1:${gptPort}`,
    proxyKey: "local-key",
  });
  const routerPort = await listen(router);

  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (upstreamResponse) => {
          const chunks = [];
          upstreamResponse.on("data", (chunk) => chunks.push(chunk));
          upstreamResponse.on("end", () =>
            resolve({
              status: upstreamResponse.statusCode,
              headers: upstreamResponse.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(
        JSON.stringify({
          model: "claude-sonnet-5[1m][effort=xhigh]",
          stream: true,
          max_tokens: 64,
          messages: [{ role: "user", content: "work" }],
        }),
      );
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.deepEqual(response.body, compressedSse);
    assert.deepEqual(
      requests.map((request) => [request.url, request.acceptEncoding]),
      [
        ["/v1/messages/count_tokens", "identity"],
        ["/v1/messages", "identity"],
      ],
    );
  } finally {
    await Promise.all([close(router), close(gpt)]);
  }
});
