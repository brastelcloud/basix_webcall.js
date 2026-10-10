"use strict";

const http = require("node:http");
const https = require("node:https");
const { readFileSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

function validateConfig(config) {
  const base = new URL(config.basix_base_url);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("basix_base_url must be an HTTPS URL without credentials, query, or fragment");
  }
  if (typeof config.basix_domain_name !== "string" || !config.basix_domain_name.trim() || config.basix_domain_name.includes(":")) {
    throw new Error("Set basix_domain_name to the domain owning the API token");
  }
  if (typeof config.basix_api_token !== "string" || !config.basix_api_token.trim()) {
    throw new Error("Set basix_api_token");
  }
  const port = config.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
  if (config.trust_proxy !== undefined && typeof config.trust_proxy !== "boolean") {
    throw new Error("trust_proxy must be a boolean");
  }
  const tls = config.tls ?? { enabled: false };
  if (!tls || typeof tls !== "object" || Array.isArray(tls) ||
      (tls.enabled !== undefined && typeof tls.enabled !== "boolean")) {
    throw new Error("tls must be an object with a boolean enabled setting");
  }
  if (tls.enabled && [tls.key_file, tls.cert_file].some(file => typeof file !== "string" || !file.trim())) {
    throw new Error("Set tls.key_file and tls.cert_file when TLS is enabled");
  }
  let publicOrigin;
  if (config.public_origin) {
    const url = new URL(config.public_origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      throw new Error("public_origin must contain only the public scheme, host, and port");
    }
    publicOrigin = url.origin;
  }
  return { ...config, tls, trust_proxy: config.trust_proxy === true, public_origin: publicOrigin,
    basix_base_url: base.href.replace(/\/$/, ""), host: config.host || "127.0.0.1", port };
}

function originAllowed(req, config) {
  // Browser-provided fetch metadata refers to the public URL, so it survives
  // proxy changes to Host, scheme, or port. Scripts cannot set Sec-* headers.
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    if (!["http:", "https:"].includes(origin.protocol)) return false;
    if (config.public_origin) return origin.origin === config.public_origin;
    if (fetchSite === "same-origin") return true;
    const forwardedHost = req.headers["x-forwarded-host"];
    const forwardedProto = req.headers["x-forwarded-proto"];
    if (config.trust_proxy && (forwardedHost !== undefined || forwardedProto !== undefined)) {
      // The proxy must overwrite both headers with one public host and scheme.
      // Reject lists and URL delimiters rather than guessing which proxy to trust.
      if (typeof forwardedHost !== "string" || !forwardedHost || /[\s,\/@?#\\]/.test(forwardedHost) ||
          !["http", "https"].includes(forwardedProto)) return false;
      const expected = new URL(`${forwardedProto}://${forwardedHost}`);
      return origin.origin === expected.origin;
    }
    return origin.host === req.headers.host;
  } catch (_) {
    return false;
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new Error("Request body too large");
  }
  return JSON.parse(body);
}

function createServer(rawConfig, { fetchImpl = fetch } = {}) {
  const config = validateConfig(rawConfig);
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    "/app.bundle.js": ["app.bundle.js", "text/javascript; charset=utf-8"],
  };
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const mountPath = "/basix_webcall_test";
      if (req.method === "GET" && url.pathname === mountPath) {
        res.writeHead(302, { Location: `${mountPath}/${url.search}` });
        return res.end();
      }
      // Support proxies that preserve the prefix as well as those that strip it.
      const pathname = url.pathname.startsWith(`${mountPath}/`)
        ? url.pathname.slice(mountPath.length)
        : url.pathname;
      if (pathname === "/api/ws-ticket" && req.method === "POST") {
        if (!originAllowed(req, config)) {
          console.warn("Ticket request origin rejected:", {
            origin: req.headers.origin,
            host: req.headers.host,
            forwardedHost: req.headers["x-forwarded-host"],
            forwardedProto: req.headers["x-forwarded-proto"],
            fetchSite: req.headers["sec-fetch-site"],
          });
          return json(res, 403, { error: "Request origin is not allowed" });
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
          return json(res, 415, { error: "Use application/json" });
        }
        let args;
        try { args = await readBody(req); }
        catch (_) { return json(res, 400, { error: "Invalid JSON request body" }); }
        if (!args || typeof args.destination !== "string" || !/^[+0-9*#]{1,64}$/.test(args.destination)) {
          return json(res, 400, { error: "Enter a destination containing digits, +, *, or #" });
        }
        if (typeof args.peer_name !== "string" || !args.peer_name.trim() ||
            args.peer_name.trim().length > 128 || /[\x00-\x1f\x7f]/.test(args.peer_name)) {
          return json(res, 400, { error: "Enter a peer name of 1 to 128 characters without control characters" });
        }
        let data;
        try {
          const upstream = await fetchImpl(`${config.basix_base_url}/api/gen_ws_ticket`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Basic ${Buffer.from(`${config.basix_domain_name}:${config.basix_api_token}`).toString("base64")}`,
            },
            body: JSON.stringify({
              uri: `${new URL(config.basix_base_url).pathname}/api/ws_sip`,
              destination: args.destination,
              peer_name: args.peer_name.trim(),
            }),
            signal: AbortSignal.timeout(10000),
            redirect: "error",
          });
          if (!upstream.ok) throw new Error("Basix HTTP failure");
          data = await upstream.json();
          if (data.result_code !== 0 || typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.ticket)) {
            throw new Error("Basix ticket failure");
          }
        } catch (_) {
          // Upstream error bodies may contain credentials. Keep them server-side.
          return json(res, 502, { error: "Unable to obtain a Basix WebSocket ticket. Check the server configuration." });
        }
        return json(res, 200, {
          ws_ticket: data.ticket,
          destination: `destination_ticket.${data.ticket}`,
          basix_base_url: config.basix_base_url,
        });
      }
      if (req.method === "GET" && assets[pathname]) {
        const [filename, contentType] = assets[pathname];
        const contents = await fs.readFile(path.join(__dirname, "public", filename));
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        return res.end(contents);
      }
      json(res, 404, { error: "Not found" });
    } catch (_) {
      if (!res.headersSent) json(res, 500, { error: "Unable to serve this request" });
      else res.end();
    }
  };
  if (config.tls.enabled) {
    return https.createServer({
      key: readFileSync(path.resolve(__dirname, config.tls.key_file)),
      cert: readFileSync(path.resolve(__dirname, config.tls.cert_file)),
      minVersion: "TLSv1.2",
    }, handler);
  }
  return http.createServer(handler);
}

async function main() {
  const filename = path.join(__dirname, "config", "default.json");
  let config;
  try { config = validateConfig(JSON.parse(await fs.readFile(filename, "utf8"))); }
  catch (error) {
    console.error(`Cannot load config/default.json: ${error.code === "ENOENT" ? "Copy config/default.json.sample to config/default.json and fill in your Basix settings." : error.message}`);
    process.exitCode = 1;
    return;
  }
  let server;
  try { server = createServer(config); }
  catch (error) {
    console.error("Cannot create server:", error.message);
    process.exitCode = 1;
    return;
  }
  server.on("error", error => { console.error("Server failed:", error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => {
    console.log(`Sample app listening at ${config.tls.enabled ? "https" : "http"}://${config.host}:${server.address().port}`);
  });
}

if (require.main === module) main();
module.exports = { createServer, validateConfig };
