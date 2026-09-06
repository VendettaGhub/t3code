const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { gzipSync } = require("node:zlib");
const { createServer } = require(process.env.QWEN_TEST_ROUTER || "./claude-hybrid-router.cjs");

for (const scenario of [
  { name: "caps excessive output", count: 100, requested: 131072, expected: 32768 },
  { name: "uses remaining context", count: 120000, requested: 32768, expected: 10048 },
  { name: "preserves small output", count: 100, requested: 128, expected: 128 },
  { name: "defaults missing output", count: 100, expected: 8192 },
  { name: "rejects exhausted context", count: 130000, requested: 8192, status: 400 },
  { name: "rejects invalid output", count: 100, requested: -1, status: 400 },
  { name: "fails closed on missing count", count: null, requested: 8192, status: 503 },
  { name: "fails closed on fractional count", count: 12.5, requested: 8192, status: 503 },
  {
    name: "guards fallback too",
    count: 120000,
    requested: 131072,
    expected: 10048,
    fallback: true,
  },
  {
    name: "caps explicit thinking budget",
    count: 120000,
    requested: 131072,
    expected: 10048,
    thinking: { type: "enabled", budget_tokens: 64000 },
  },
  {
    name: "rejects too little room for thinking",
    count: 100,
    requested: 128,
    status: 400,
    thinking: { type: "enabled", budget_tokens: 1024 },
  },
  { name: "rejects negative count", count: -1, requested: 8192, status: 503 },
]) {
  test(`Qwen budget: ${scenario.name}`, async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks));
        seen.push({ path: req.url, payload, headers: req.headers });
        res.setHeader("content-type", "application/json");
        const reply = JSON.stringify(
          req.url.endsWith("/count_tokens")
            ? { input_tokens: scenario.count }
            : { type: "message", content: [{ type: "text", text: "OK" }] },
        );
        if (req.url.endsWith("/count_tokens") && req.headers["accept-encoding"]?.includes("gzip")) {
          res.setHeader("content-encoding", "gzip");
          res.end(gzipSync(reply));
        } else res.end(reply);
      });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const router = createServer({
      proxyKey: "fixture",
      gptUrl: "http://127.0.0.1:1",
      qwenUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    await new Promise((resolve) => router.listen(0, "127.0.0.1", resolve));
    const messages = [{ role: "user", content: "Synthetic fixture. Do not discard." }];
    try {
      const response = await fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "secret-fixture" },
        body: JSON.stringify({
          model: scenario.fallback ? "gpt-5.6-luna" : "qwen3.8-27b[effort=xhigh]",
          max_tokens: scenario.requested,
          thinking: scenario.thinking,
          messages,
        }),
      });
      const body = await response.json();
      assert.equal(response.status, scenario.status || 200, JSON.stringify(body));
      const generated = seen.filter((item) => item.path === "/v1/messages");
      if (scenario.status) assert.equal(generated.length, 0);
      else {
        assert.equal(generated.length, 1);
        assert.equal(generated[0].payload.max_tokens, scenario.expected);
        if (scenario.thinking)
          assert.equal(generated[0].payload.thinking.budget_tokens, scenario.expected - 1);
        assert.deepEqual(generated[0].payload.messages, messages);
        assert.equal(seen[0].path, "/v1/messages/count_tokens");
        assert.ok(seen.every((item) => !item.headers.authorization));
        if (!scenario.fallback) assert.equal(generated[0].payload.output_config.effort, "xhigh");
      }
    } finally {
      await Promise.all(
        [router, upstream].map((server) => new Promise((resolve) => server.close(resolve))),
      );
    }
  });
}
