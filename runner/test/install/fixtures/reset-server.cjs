// Runs one client case against a local TLS server that cuts its first answers short with a TCP reset, then
// prints what the client got and when each request arrived. The test runs it under node with NODE_OPTIONS
// loading etc/retry-reset.cjs, the way a session's commands run.
//
// node reset-server.cjs <key.pem> <cert.pem> <client> <method> <where> <cuts>
//   client: fetch, request, or get. where: body (after 5 of 10 bytes) or head (before any answer).
"use strict";
const fs = require("fs");
const https = require("https");
const net = require("net");
const tls = require("tls");

const [keyFile, certFile, client, method, where, cutsText] = process.argv.slice(2);
const key = fs.readFileSync(keyFile);
const cert = fs.readFileSync(certFile);
const cuts = Number(cutsText);
const BODY = "0123456789";
const start = Date.now();
const arrivals = [];

const server = net.createServer((raw) => {
  const socket = new tls.TLSSocket(raw, { isServer: true, key, cert });
  socket.on("error", () => {});
  let text = "";
  socket.on("data", (data) => {
    text += data;
    if (!text.includes("\r\n\r\n")) return;
    text = "";
    arrivals.push(Date.now() - start);
    const cut = arrivals.length <= cuts;
    const body = method === "HEAD" ? "" : cut && where === "body" ? BODY.slice(0, 5) : BODY;
    const reset = () => setTimeout(() => raw.resetAndDestroy(), 50);
    if (cut && where === "head") return reset();
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\n\r\n${body}`, cut ? reset : undefined);
  });
});

function viaFetch(url) {
  return fetch(url, { method }).then(async (response) => ({ status: response.status, url: response.url, body: await response.text() }));
}

function viaRequest(url) {
  return new Promise((resolve, reject) => {
    const options = { method, rejectUnauthorized: false };
    const onResponse = (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, complete: res.complete }));
      res.on("error", reject);
    };
    const req = client === "get" ? https.get(url, options, onResponse) : https.request(url, options, onResponse);
    req.on("error", reject);
    if (client !== "get") req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  const url = `https://127.0.0.1:${server.address().port}/font.woff2`;
  let result;
  try {
    result = { ok: true, ...(await (client === "fetch" ? viaFetch(url) : viaRequest(url))) };
  } catch (error) {
    let codes = [];
    for (let each = error; each; each = each.cause) codes.push(each.code ?? each.message);
    result = { ok: false, codes };
  }
  // Exit at once: a kept-alive socket would hold the server open for seconds.
  process.stdout.write(JSON.stringify({ ...result, arrivals }), () => process.exit(0));
});
