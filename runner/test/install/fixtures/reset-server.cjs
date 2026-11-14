// Runs one client case against a local TLS server that cuts its first answers short with a TCP reset, then
// prints what the client got and when each request arrived. The test runs it under node with NODE_OPTIONS
// loading etc/retry-reset.cjs, the way a session's commands run.
//
// node reset-server.cjs <key.pem> <cert.pem> <client> <method> <where> <cuts> [served]
//   client: fetch, request, or get; header, which sets a header after https.request(); cancel, which destroys
//   the request 500 ms in; destroy-response and cancel-body, which destroy the https response or cancel the
//   fetch body 500 ms in; paused, which reads nothing for 300 ms and reports what the response buffered; body,
//   which sends a one-byte body; timeout, which sets a 300 ms timeout that destroys the request; or abort,
//   which aborts the fetch 300 ms after the first reset, and reports when.
//   where: body (after 5 of 10 bytes), head (before any answer), large (a 1 MiB body, never cut), or stall
//   (cut like head, then never answer).
//   served: etag (the default), date (Last-Modified and no ETag), none (neither), or changed (a new ETag and
//   body after the first answer).
"use strict";
const fs = require("fs");
const https = require("https");
const net = require("net");
const tls = require("tls");

const [keyFile, certFile, client, method, where, cutsText] = process.argv.slice(2);
const key = fs.readFileSync(keyFile);
const cert = fs.readFileSync(certFile);
const cuts = Number(cutsText);
const served = process.argv[8] ?? "etag";
const BODY = "0123456789";
const CHANGED = "abcdefghij";
const LARGE = "x".repeat(1 << 20);
const start = Date.now();
const arrivals = [];
let abortedAt;
// Whether each request carried the header the header client sets.
const tokens = [];
// Runs after each reset.
let afterReset = () => {};

const server = net.createServer((raw) => {
  const socket = new tls.TLSSocket(raw, { isServer: true, key, cert });
  socket.on("error", () => {});
  let text = "";
  socket.on("data", (data) => {
    text += data;
    if (!text.includes("\r\n\r\n")) return;
    tokens.push(/^x-token: t\r$/im.test(text));
    text = "";
    arrivals.push(Date.now() - start);
    const cut = arrivals.length <= cuts;
    const changed = served === "changed" && arrivals.length > 1;
    const full = where === "large" ? LARGE : changed ? CHANGED : BODY;
    const body = method === "HEAD" ? "" : cut && where === "body" ? full.slice(0, 5) : full;
    const validator =
      served === "date" ? "Last-Modified: Wed, 11 May 2022 19:24:48 GMT\r\n" : served === "none" ? "" : `ETag: "${changed ? "v2" : "v1"}"\r\n`;
    const reset = () =>
      setTimeout(() => {
        raw.resetAndDestroy();
        afterReset();
      }, 50);
    if (cut && (where === "head" || where === "stall")) return reset();
    if (where === "stall") return;
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${full.length}\r\n${validator}\r\n${body}`, cut ? reset : undefined);
  });
});

function viaFetch(url) {
  if (client === "abort") {
    const controller = new AbortController();
    afterReset = () => {
      afterReset = () => {};
      setTimeout(() => {
        abortedAt = Date.now() - start;
        controller.abort();
      }, 300);
    };
    return fetch(url, { method, signal: controller.signal }).then((response) => response.text());
  }
  if (client === "cancel-body") {
    return fetch(url, { method }).then(async (response) => {
      const reader = response.body.getReader();
      await reader.read();
      await wait(500);
      await reader.cancel();
      // Long enough for the 1 second retry to have arrived, had it run.
      await wait(1500);
      return { status: response.status };
    });
  }
  return fetch(url, { method }).then(async (response) => ({
    status: response.status,
    url: response.url,
    cloneUrl: response.clone().url,
    body: await response.text(),
  }));
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function viaRequest(url) {
  let req;
  return new Promise((resolve, reject) => {
    const options = { method, rejectUnauthorized: false };
    if (client === "paused") {
      const req = https.request(url, options, (res) => {
        res.pause();
        setTimeout(() => resolve({ status: res.statusCode, buffered: res.readableLength }), 300);
      });
      req.on("error", reject);
      return req.end();
    }
    if (client === "cancel" || client === "destroy-response") {
      let response = null;
      const req = https.request(url, options, (res) => (response = res.on("error", () => {}).resume()));
      let closed = false;
      req.on("error", () => {});
      req.on("close", () => (closed = true));
      req.end();
      setTimeout(() => (client === "cancel" ? req.destroy() : response.destroy()), 500);
      // Long enough for the 1 second retry to have arrived, had it run.
      return setTimeout(() => resolve({ closed }), 2000);
    }
    const onResponse = (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, complete: res.complete, ownRequest: res.req === req }));
      res.on("error", reject);
    };
    req = client === "get" ? https.get(url, options, onResponse) : https.request(url, options, onResponse);
    if (client === "header") req.setHeader("X-Token", "t");
    if (client === "timeout") req.setTimeout(300, () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (client === "body") req.end("x");
    else if (client !== "get") req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  const url = `https://127.0.0.1:${server.address().port}/font.woff2`;
  let result;
  try {
    result = { ok: true, ...(await (["fetch", "cancel-body", "abort"].includes(client) ? viaFetch(url) : viaRequest(url))) };
  } catch (error) {
    let codes = [];
    for (let each = error; each; each = each.cause) codes.push(each.name === "AbortError" ? "AbortError" : (each.code ?? each.message));
    result = { ok: false, codes };
  }
  // Exit at once: a kept-alive socket would hold the server open for seconds.
  process.stdout.write(JSON.stringify({ ...result, arrivals, tokens, abortedAt, ended: Date.now() - start }), () => process.exit(0));
});
