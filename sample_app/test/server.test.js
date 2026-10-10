"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createServer, validateConfig, loadConfig } = require("../server");

const config = {
  basix_base_url: "https://qabcs.brastel.com/basix/",
  basix_domain_name: "example.basix.ne.jp",
  basix_api_token: "test-secret-token",
};

test("loads the Render secret configuration before the local file", async () => {
  const files = [];
  const loaded = await loadConfig(async (filename, encoding) => {
    files.push(filename);
    assert.equal(encoding, "utf8");
    return JSON.stringify(config);
  });
  assert.deepEqual(files, ["/etc/secrets/config.json"]);
  assert.equal(loaded.basix_api_token, config.basix_api_token);
});

test("falls back to local configuration only when the secret file is absent", async () => {
  const files = [];
  await loadConfig(async filename => {
    files.push(filename);
    if (filename === "/etc/secrets/config.json") {
      throw Object.assign(new Error("Missing"), { code: "ENOENT" });
    }
    return JSON.stringify(config);
  });
  assert.deepEqual(files, ["/etc/secrets/config.json", path.resolve(__dirname, "../config/default.json")]);
  for (const failure of [new Error("Permission denied"), new SyntaxError("Invalid JSON")]) {
    let reads = 0;
    await assert.rejects(loadConfig(async () => {
      reads++;
      if (failure instanceof SyntaxError) return "invalid JSON";
      throw failure;
    }));
    assert.equal(reads, 1);
  }
});

async function app(t, fetchImpl, overrides = {}) {
  const server = createServer({ ...config, ...overrides }, { fetchImpl });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request: (body, headers = {}) => fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body && { peer_name: "Test caller", ...body }),
    }),
  };
}

test("obtains a destination-bound ticket with server-side Basic authentication", async t => {
  let upstreamRequest;
  const { request } = await app(t, async (url, options) => {
    upstreamRequest = { url, options };
    return { ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }) };
  });
  const response = await request({ destination: "0312341234", peer_name: "  山田 太郎  " });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(!text.includes(config.basix_api_token));
  assert.deepEqual(JSON.parse(text), {
    ws_ticket: "abc123", destination: "0312341234",
    basix_base_url: "https://qabcs.brastel.com/basix",
  });
  assert.equal(upstreamRequest.url, "https://qabcs.brastel.com/basix/api/gen_ws_ticket");
  assert.equal(upstreamRequest.options.method, "POST");
  assert.equal(upstreamRequest.options.headers.Authorization,
    `Basic ${Buffer.from(`${config.basix_domain_name}:${config.basix_api_token}`).toString("base64")}`);
  assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
    uri: "/basix/api/ws_sip", destination: "0312341234", peer_name: ".........",
  });
});

test("invalid destinations are rejected before reaching Basix", async t => {
  let requests = 0;
  const { request } = await app(t, () => { requests++; });
  for (const body of [{}, null, { destination: "123@other-host" }, { destination: 123 }]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal(requests, 0);
});

test("missing or invalid peer names are rejected before reaching Basix", async t => {
  let requests = 0;
  const { request } = await app(t, () => { requests++; });
  for (const peer_name of [undefined, "", 123, "a".repeat(129)]) {
    const response = await request({ destination: "0312341234", peer_name });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /peer name/);
  }
  assert.equal(requests, 0);
});

test("replaces each invalid peer name character with a dot", async t => {
  const names = [];
  const { request } = await app(t, async (_, options) => {
    names.push(JSON.parse(options.body).peer_name);
    return { ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }) };
  });
  for (const peer_name of ["AZaz09.name", " John_Doe-42@x ", "name\r\nother", "山田🙂", "   "]) {
    assert.equal((await request({ destination: "123", peer_name })).status, 200);
  }
  assert.deepEqual(names, ["AZaz09.name", ".John.Doe.42.x.", "name..other", "...", "..."]);
});

test("Basix HTTP, API, and network failures do not expose upstream secrets", async t => {
  const replies = [
    { ok: false },
    { ok: true, json: async () => ({ result_code: 1, error: config.basix_api_token }) },
    { ok: true, json: async () => ({ result_code: 0, ticket: "bad@ticket" }) },
    new Error(config.basix_api_token),
  ];
  const { request } = await app(t, async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  });
  for (let i = 0; i < 4; i++) {
    const response = await request({ destination: "0312341234" });
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(config.basix_api_token));
  }
});

test("serves the page and stylesheet, keeps config and source files private", async t => {
  const { base } = await app(t, () => {});
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="call-form"/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  for (const filename of ["config/default.json", "server.js", "../package.json"]) {
    assert.equal((await fetch(`${base}/${filename}`)).status, 404);
  }
});

test("rejects cross-origin ticket requests and non-JSON content", async t => {
  const { request, base } = await app(t, () => { throw new Error("Must not call Basix"); });
  assert.equal((await request({ destination: "123" }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await fetch(`${base}/api/ws-ticket`, { method: "POST", body: "123" })).status, 415);
  assert.equal((await fetch(`${base}/api/ws-ticket`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "broken JSON",
  })).status, 400);
});

test("validates required Basix configuration", () => {
  assert.equal(validateConfig(config).host, "127.0.0.1");
  assert.equal(validateConfig(config).port, 3000);
  assert.throws(() => validateConfig({ ...config, basix_base_url: "http://example.com" }), /HTTPS/);
  assert.throws(() => validateConfig({ ...config, basix_domain_name: "" }), /domain/);
  assert.throws(() => validateConfig({ ...config, basix_api_token: "" }), /token/);
  assert.throws(() => validateConfig({ ...config, public_origin: "https://example.com/app/" }), /public_origin/);
  assert.throws(() => validateConfig({ ...config, trust_proxy: "true" }), /trust_proxy/);
  assert.equal(validateConfig(config).tls.enabled, false);
  assert.throws(() => validateConfig({ ...config, tls: { enabled: "true" } }), /tls/);
  assert.throws(() => validateConfig({ ...config, tls: { enabled: true } }), /key_file/);
});

test("direct HTTPS serves the page and obtains tickets without proxy headers", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webcall-tls-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key_file = path.join(directory, "key.pem");
  const cert_file = path.join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key_file, "-out", cert_file, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const server = createServer({ ...config, trust_proxy: false,
    tls: { enabled: true, key_file, cert_file } }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }) }),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `https://127.0.0.1:${server.address().port}`;
  const request = (pathname, options = {}, body) => new Promise((resolve, reject) => {
    const req = https.request(`${base}${pathname}`, { ca: fs.readFileSync(cert_file), ...options }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/basix_webcall_test/")).status, 200);
  const response = await request("/api/ws-ticket", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
  }, JSON.stringify({ destination: "123", peer_name: "Internet caller" }));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).ws_ticket, "abc123");
});

test("trusted proxy origin detection works across dev hosts and ports", async t => {
  let calls = 0;
  const { request } = await app(t, async () => {
    calls++;
    return { ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }) };
  }, { trust_proxy: true });
  for (const host of ["192.168.225.24:1443", "dev-two.example:8443", "dev-three.example", "[::1]:1443"]) {
    const response = await request({ destination: "123" }, {
      Origin: `https://${host}`, "X-Forwarded-Host": host, "X-Forwarded-Proto": "https",
    });
    assert.equal(response.status, 200);
  }
  for (const forwarded of [
    { "X-Forwarded-Host": "dev.example:1443", "X-Forwarded-Proto": "http" },
    { "X-Forwarded-Host": "other.example", "X-Forwarded-Proto": "https" },
    { "X-Forwarded-Host": "dev.example:1443, other.example", "X-Forwarded-Proto": "https" },
    { "X-Forwarded-Host": "dev.example:1443" },
    { "X-Forwarded-Host": "dev.example:1443/path", "X-Forwarded-Proto": "https" },
  ]) {
    const response = await request({ destination: "123" }, { Origin: "https://dev.example:1443", ...forwarded });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 4);
});

test("forwarded headers cannot bypass origin checks without explicit proxy trust", async t => {
  const { request } = await app(t, () => { throw new Error("Must not call Basix"); });
  const response = await request({ destination: "123" }, {
    Origin: "https://other.example", "X-Forwarded-Host": "other.example", "X-Forwarded-Proto": "https",
  });
  assert.equal(response.status, 403);
});

test("same-origin browser metadata works when the proxy rewrites host and loses the public port", async t => {
  let calls = 0;
  const { request } = await app(t, async () => {
    calls++;
    return { ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }) };
  }, { trust_proxy: true });
  for (const origin of ["https://192.168.225.24:1443", "https://another-dev.example:8443"]) {
    const response = await request({ destination: "123" }, {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Host": new URL(origin).hostname,
      "X-Forwarded-Proto": "http",
    });
    assert.equal(response.status, 200);
  }
  for (const site of ["cross-site", "same-site", "none"]) {
    assert.equal((await request({ destination: "123" }, {
      Origin: "https://another-dev.example:8443", "Sec-Fetch-Site": site,
    })).status, 403);
  }
  assert.equal(calls, 2);
});

test("same-origin metadata does not override an explicitly pinned public origin", async t => {
  const { request } = await app(t, () => { throw new Error("Must not call Basix"); }, {
    public_origin: "https://expected.example",
  });
  assert.equal((await request({ destination: "123" }, {
    Origin: "https://other.example", "Sec-Fetch-Site": "same-origin",
  })).status, 403);
});

test("allows configured public origin behind a proxy while rejecting other origins", async t => {
  const public_origin = "https://192.168.225.24:1443";
  let upstreamRequests = 0;
  const { request } = await app(t, async () => {
    upstreamRequests++;
    return { ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }) };
  }, { public_origin });
  // The listener's Host is 127.0.0.1:<internal port>, unlike the public Origin.
  assert.equal((await request({ destination: "123" }, { Origin: public_origin })).status, 200);
  for (const origin of ["https://192.168.225.24", "http://192.168.225.24:1443", "https://other.example", "null"]) {
    const response = await request({ destination: "123" }, {
      Origin: origin, "X-Forwarded-Host": "192.168.225.24:1443",
    });
    assert.equal(response.status, 403);
  }
  assert.equal(upstreamRequests, 1);
});

test("serves prefixed assets and ticket requests, redirects to a trailing slash", async t => {
  const { base } = await app(t, async () => ({
    ok: true, json: async () => ({ result_code: 0, ticket: "abc123" }),
  }));
  const prefix = `${base}/basix_webcall_test/`;
  const redirect = await fetch(`${base}/basix_webcall_test`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/basix_webcall_test/");
  const page = await fetch(prefix);
  assert.equal(page.status, 200);
  const html = await page.text();
  const stylesheet = html.match(/href="([^"]+)"/)[1];
  const script = html.match(/src="([^"]+)"/)[1];
  assert.equal((await fetch(new URL(stylesheet, prefix))).status, 200);
  const bundle = await fetch(new URL(script, prefix));
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /\.\/api\/ws-ticket/);
  const ticket = await fetch(new URL("./api/ws-ticket", prefix), {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ destination: "0312341234", peer_name: "Test caller" }),
  });
  assert.equal(ticket.status, 200);
  assert.equal((await ticket.json()).ws_ticket, "abc123");
  assert.equal((await fetch(`${prefix}config/default.json`)).status, 404);
});
