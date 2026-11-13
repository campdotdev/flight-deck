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
  let canceled = false;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (!isReset(error) || attempts >= DELAYS_MS.length) throw error;
          await sleep(DELAYS_MS[attempts++]);
          // The caller canceled the body while the retry waited, or while it was on its way.
          if (canceled) return;
          let next;
          try {
            next = await originalFetch.call(self, input, init);
          } catch (again) {
            if (isReset(again)) continue;
            throw again;
          }
          if (canceled) {
            if (next.body !== null) await next.body.cancel().catch(() => {});
            return;
          }
          // A different answer can't continue the body the caller already holds part of.
          const header = (response) => (name) => response.headers.get(name);
          if (next.status !== first.status || next.body === null || !sameRepresentation(header(first), header(next))) {
            if (next.body !== null) await next.body.cancel().catch(() => {});
            throw error;
          }
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
      canceled = true;
      // A reader a reset errored has nothing left to cancel.
      return reader.cancel(reason).catch(() => {});
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
 * timeout, or close reach it as the first request's own. Destroying the first request stops a pending or
 * running retry. A request that sends a body isn't retried, because a retry can't send it again.
 */
function retryResets(self, req, args) {
  const emit = req.emit;
  const destroy = req.destroy;
  const write = req.write;
  const end = req.end;
  const setRequestTimeout = req.setTimeout;
  let sendsBody = false;
  let timeoutMs = null;
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
    // Nothing after this reaches the caller.
    canceled = true;
    forward("error", error);
    if (proxy !== null) proxy.destroy(error);
    close();
  }

  /** Stops a pending retry and any replacement in flight, whose later events are then ignored. */
  function cancel() {
    canceled = true;
    clearTimeout(timer);
    retrying = false;
    if (active !== req) active.destroy();
  }

  const isBody = (chunk) => chunk != null && typeof chunk !== "function" && chunk.length !== 0;
  req.write = function (chunk, ...rest) {
    if (isBody(chunk)) sendsBody = true;
    return write.call(this, chunk, ...rest);
  };
  req.end = function (chunk, ...rest) {
    if (isBody(chunk)) sendsBody = true;
    return end.call(this, chunk, ...rest);
  };

  // A timeout the caller sets applies to whichever attempt is in flight, and each retry starts with it.
  req.setTimeout = function (ms, callback) {
    timeoutMs = ms;
    if (active !== req) active.setTimeout(ms);
    return setRequestTimeout.call(this, ms, callback);
  };

  // Before a retry, the first request is the attempt in flight, and destroying it is enough. After one, the
  // first request is already gone, so this stops the retry and ends the caller's request as destroy would.
  req.destroy = function (error) {
    if (active === req && !retrying) {
      canceled = true;
      return destroy.call(this, error);
    }
    if (closed) return this;
    cancel();
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
      const declared = Number(req.getHeader("content-length")) > 0;
      if (!canceled && !sendsBody && !declared && isReset(error) && attempts < DELAYS_MS.length) {
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
          if (timeoutMs !== null) next.setTimeout(timeoutMs);
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
        proxy.req = req;
        statusCode = res.statusCode;
        // Destroying the caller's response cancels the request it belongs to. Before a retry, destroying the
        // response's socket is enough; after one, the request closes here, as a destroyed response's would.
        const destroyResponse = proxy._destroy;
        proxy._destroy = function (error, callback) {
          if (!canceled && !closed) {
            if (active === req && !retrying) canceled = true;
            else {
              cancel();
              close();
            }
          }
          return destroyResponse.call(this, error, callback);
        };
        // The caller reading again resumes whichever response feeds it.
        proxy._read = () => {
          if (current !== null) current.resume();
        };
        forward("response", proxy);
      } else if (res.statusCode !== statusCode || !sameRepresentation((name) => proxy.headers[name], (name) => res.headers[name])) {
        failed = true;
        // Stop the rejected answer's download rather than read it to the end.
        res.on("error", () => {});
        res.destroy();
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
    attempt.on("timeout", () => {
      if (!canceled) forward("timeout");
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
