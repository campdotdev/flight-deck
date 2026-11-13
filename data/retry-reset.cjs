// Flight Deck's NODE_OPTIONS script (spec 1, "Folders and files", ADR 0007). The runner copies it to etc/ and
// every session's NODE_OPTIONS loads it with --require.
//
// sandbox-runtime's proxy closes the client's socket as soon as the upstream closes, so a download can end early
// with ECONNRESET, and Next's font download then never finished. This retries a GET or HEAD request, through
// fetch or https.request, whose socket closes with ECONNRESET before the response ends: up to 3 times, 1, 2, and
// 4 seconds apart. A retry that comes after the caller has the response skips the bytes the caller already has,
// so the caller sees one whole response, but only when the retry answers with the same representation;
// otherwise the caller gets the reset. It changes nothing else. The real fix belongs in sandbox-runtime.
"use strict";

const DELAYS_MS = [1000, 2000, 4000];
const RETRIED = new Set(["GET", "HEAD"]);

/** Whether an error, or any error in its cause chain, is an ECONNRESET. */
function isReset(error) {
  for (let each = error, depth = 0; each !== null && typeof each === "object" && depth < 8; each = each.cause, depth++) {
    if (each.code === "ECONNRESET") return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Whether a retry's answer is the same representation as the first answer, so its bytes can continue the body
 * the caller already has: the same strong ETag, or, with none, the same Last-Modified and Content-Length.
 * fonts.gstatic.com sends no ETag. Each argument looks up one of an answer's headers by its lowercase name.
 */
function sameRepresentation(first, next) {
  const etag = first("etag");
  if (etag && !etag.startsWith("W/")) return next("etag") === etag;
  const modified = first("last-modified");
  const length = first("content-length");
  return Boolean(modified && length) && next("last-modified") === modified && next("content-length") === length;
}

// fetch.

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = function fetch(input, init) {
    const method = String((init && init.method) || (typeof Request === "function" && input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!RETRIED.has(method)) return originalFetch.call(this, input, init);
    return fetchWithRetries(this, input, init);
  };
}

async function fetchWithRetries(self, input, init) {
  let attempts = 0;
  let response;
  for (;;) {
    try {
      response = await originalFetch.call(self, input, init);
      break;
    } catch (error) {
      if (!isReset(error) || attempts >= DELAYS_MS.length) throw error;
      await sleep(DELAYS_MS[attempts++]);
    }
  }
  if (response.body === null) return response;

  const first = response;
  let reader = first.body.getReader();
  let skip = 0;
  let delivered = 0;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (!isReset(error) || attempts >= DELAYS_MS.length) throw error;
          await sleep(DELAYS_MS[attempts++]);
          let next;
          try {
            next = await originalFetch.call(self, input, init);
          } catch (again) {
            if (isReset(again)) continue;
            throw again;
          }
          // A different answer can't continue the body the caller already holds part of.
          const header = (response) => (name) => response.headers.get(name);
          if (next.status !== first.status || next.body === null || !sameRepresentation(header(first), header(next))) throw error;
          reader = next.body.getReader();
          skip = delivered;
          continue;
        }
        if (chunk.done) {
          controller.close();
          return;
        }
        let bytes = chunk.value;
        if (skip > 0) {
          const dropped = Math.min(skip, bytes.byteLength);
          skip -= dropped;
          bytes = bytes.subarray(dropped);
          if (bytes.byteLength === 0) continue;
        }
        delivered += bytes.byteLength;
        controller.enqueue(bytes);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const wrapped = new Response(body, { status: first.status, statusText: first.statusText, headers: first.headers });
  // A Response built from a stream has no url, and isn't redirected, so it keeps the first one's.
  for (const key of ["url", "redirected", "type"]) Object.defineProperty(wrapped, key, { value: first[key], enumerable: true });
  return wrapped;
}

// https.request, and https.get, which calls Node's own request rather than the module's.

const http = require("http");
const https = require("https");
const originalRequest = https.request;

https.request = function request(...args) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
  const options = args.find((arg) => arg !== null && typeof arg === "object" && !(arg instanceof URL));
  const method = String((options && options.method) || "GET").toUpperCase();
  if (!RETRIED.has(method)) return originalRequest.apply(this, callback === null ? args : [...args, callback]);
  const req = originalRequest.apply(this, args);
  if (callback !== null) req.once("response", callback);
  retryResets(this, req, args);
  return req;
};

https.get = function get(...args) {
  const req = https.request(...args);
  req.end();
  return req;
};

/**
 * Hands the caller one response, fed by each attempt in turn. The caller only ever holds the first request,
 * so a reset's error and close are held back from it while a retry runs, and the last attempt's end, error,
 * or close reach it as the first request's own. Destroying the first request stops a pending or running retry.
 */
function retryResets(self, req, args) {
  const emit = req.emit;
  const destroy = req.destroy;
  let attempts = 0;
  let retrying = false;
  let canceled = false;
  let closed = false;
  let timer = null;
  // The attempt in flight, and the response that feeds the caller's.
  let active = req;
  let current = null;
  let proxy = null;
  let delivered = 0;
  let statusCode = null;

  const forward = (event, ...rest) => emit.call(req, event, ...rest);

  /** The caller's request closes once, whichever attempt ends it. */
  function close() {
    if (closed) return false;
    closed = true;
    return forward("close");
  }

  /** Ends the caller's request and response with an attempt's error, as the first request would have. */
  function fail(error) {
    retrying = false;
    forward("error", error);
    if (proxy !== null) proxy.destroy(error);
    close();
  }

  // Before a retry, the first request is the attempt in flight, and destroying it is enough. After one, the
  // first request is already gone, so this stops the retry and ends the caller's request as destroy would.
  req.destroy = function (error) {
    canceled = true;
    if (active === req && !retrying) return destroy.call(this, error);
    if (closed) return this;
    clearTimeout(timer);
    retrying = false;
    if (active !== req) active.destroy();
    if (error) forward("error", error);
    if (proxy !== null) proxy.destroy(error);
    close();
    return this;
  };

  /** Each attempt reports one failure, whichever of its request and response sees the reset first. */
  function attach(attempt, isFirst) {
    let failed = false;
    const failure = (error) => {
      if (failed) return true;
      failed = true;
      if (!canceled && isReset(error) && attempts < DELAYS_MS.length) {
        retrying = true;
        const ms = DELAYS_MS[attempts++];
        timer = setTimeout(() => {
          timer = null;
          const next = originalRequest.apply(self, args);
          // Headers the caller set or removed after https.request() reach the retry too. Headers given as an
          // array, or with Expect, are already written, and are the same on both.
          if (!next.headersSent) {
            for (const name of next.getHeaderNames()) if (!req.hasHeader(name)) next.removeHeader(name);
            for (const name of req.getRawHeaderNames()) next.setHeader(name, req.getHeader(name));
          }
          active = next;
          attach(next, false);
          next.end();
        }, ms);
        return true;
      }
      return false;
    };
    const response = (res) => {
      if (proxy === null) {
        proxy = new http.IncomingMessage(res.socket);
        for (const key of ["httpVersion", "httpVersionMajor", "httpVersionMinor", "statusCode", "statusMessage", "headers", "rawHeaders", "url", "method"]) {
          proxy[key] = res[key];
        }
        statusCode = res.statusCode;
        // The caller reading again resumes whichever response feeds it.
        proxy._read = () => {
          if (current !== null) current.resume();
        };
        forward("response", proxy);
      } else if (res.statusCode !== statusCode || !sameRepresentation((name) => proxy.headers[name], (name) => res.headers[name])) {
        failed = true;
        res.resume();
        fail(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
        return;
      }
      current = res;
      let skip = isFirst ? 0 : delivered;
      res.on("data", (chunk) => {
        if (skip > 0) {
          const dropped = Math.min(skip, chunk.length);
          skip -= dropped;
          chunk = chunk.subarray(dropped);
          if (chunk.length === 0) return;
        }
        delivered += chunk.length;
        // A full buffer pauses the response until the caller reads again.
        if (!proxy.push(chunk)) res.pause();
      });
      res.on("end", () => {
        proxy.trailers = res.trailers;
        proxy.rawTrailers = res.rawTrailers;
        proxy.complete = true;
        proxy.push(null);
      });
      res.on("error", (error) => {
        if (canceled && !isFirst) return;
        if (!failure(error) && !isFirst) fail(error);
        else if (!retrying && isFirst) proxy.destroy(error);
      });
    };

    if (isFirst) {
      req.emit = function (event, ...rest) {
        if (event === "response") {
          response(rest[0]);
          return true;
        }
        if (event === "error" && (retrying || failure(rest[0]))) return true;
        if (event === "close") return retrying ? true : close();
        return forward(event, ...rest);
      };
      return;
    }
    // A retry the caller destroyed reports nothing more: the caller's request already ended.
    attempt.on("response", (res) => {
      if (canceled) res.resume();
      else response(res);
    });
    attempt.on("error", (error) => {
      if (!canceled && !failure(error)) fail(error);
    });
    attempt.on("close", () => {
      if (!canceled && !failed) {
        retrying = false;
        close();
      }
    });
  }

  attach(req, true);
}
