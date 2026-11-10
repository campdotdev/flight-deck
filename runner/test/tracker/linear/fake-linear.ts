// A local stand-in for Linear's API, so the Linear adapter's tests never reach real Linear. It answers
// `/graphql`, `/oauth/token`, `/oauth/revoke`, and the signed upload URL the way Linear's docs describe them.
// Every GraphQL document and its variables are checked against Linear's public schema
// (`../fixtures/linear-schema.graphql`), so a field or input Linear doesn't have fails the way Linear refuses it.
// Each answer comes from a handler the test registers per operation name, written in Linear's response shape.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, getOperationAST, parse, validate, type GraphQLSchema } from "graphql";
import { getVariableValues } from "graphql/execution/values.js";

let schema: GraphQLSchema | null = null;

function linearSchema(): GraphQLSchema {
  schema ??= buildSchema(readFileSync(join(import.meta.dir, "..", "fixtures", "linear-schema.graphql"), "utf8"), { assumeValidSDL: true });
  return schema;
}

/** One GraphQL request the fake received. */
export interface Received {
  operation: string;
  query: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

/** What a handler answers: a GraphQL body, with an HTTP status (200 by default) and headers. */
export interface Reply {
  status?: number;
  data?: unknown;
  errors?: unknown[];
  /** A raw body instead of JSON, such as an HTML error page. */
  raw?: string;
  headers?: Record<string, string>;
}

export type Handler = (variables: Record<string, unknown>, request: Received) => Reply;

/** Linear's answer to a token it doesn't take. */
export const UNAUTHENTICATED: Reply = {
  status: 401,
  errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", userPresentableMessage: "You need to authenticate to access this operation." } }],
};

/** Linear's answer past a rate limit. */
export const RATELIMITED: Reply = {
  status: 429,
  headers: { "Retry-After": "60", "X-RateLimit-Requests-Remaining": "0" },
  errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED", type: "Ratelimited", userPresentableMessage: "Rate limit exceeded" } }],
};

/** Linear's answer for an issue that doesn't exist, or one the identity can't see. */
export function notFound(what = "Issue"): Reply {
  return { status: 200, data: null, errors: [{ message: `Entity not found: ${what}`, path: ["issue"], extensions: { type: "invalid input", code: "INVALID_INPUT", userPresentableMessage: `Could not find referenced ${what}.` } }] };
}

/** Linear's answer to an input it refuses. */
export function invalidInput(message: string): Reply {
  return { status: 400, errors: [{ message: "Argument Validation Error", extensions: { type: "invalid input", code: "INVALID_INPUT", userPresentableMessage: message } }] };
}

export class FakeLinear {
  readonly requests: Received[] = [];
  readonly mints: Record<string, string>[] = [];
  /** Every token a revoke named, taken or not. */
  readonly revokes: string[] = [];
  readonly puts: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  /** Client ID to secret, for each app whose mints work. */
  readonly apps = new Map<string, string>();
  /** The tokens and keys Linear takes. Each mint adds its token. */
  readonly accepted = new Set<string>();
  /** The next answers of `/oauth/token`, before the usual one. */
  readonly mintReplies: Reply[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly queued = new Map<string, Handler[]>();
  private tokens = 0;

  private constructor(private readonly server: ReturnType<typeof Bun.serve>) {}

  static start(): FakeLinear {
    let fake: FakeLinear | null = null;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => fake!.answer(request) });
    fake = new FakeLinear(server);
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    void this.server.stop(true);
  }

  /** Answers every request of the operation with the handler. */
  on(operation: string, handler: Handler | Reply): void {
    this.handlers.set(operation, typeof handler === "function" ? handler : () => handler);
  }

  /** Answers the next request of the operation with the handler, before any `on` handler. */
  once(operation: string, handler: Handler | Reply): void {
    const queue = this.queued.get(operation) ?? [];
    queue.push(typeof handler === "function" ? handler : () => handler);
    this.queued.set(operation, queue);
  }

  /** The requests of one operation, in order. */
  sent(operation: string): Received[] {
    return this.requests.filter((request) => request.operation === operation);
  }

  /** The operation names of every request, in order. */
  operations(): string[] {
    return this.requests.map((request) => request.operation);
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/graphql") return this.graphql(request);
    if (url.pathname === "/oauth/token") return this.mint(request);
    if (url.pathname === "/oauth/revoke") {
      const form = new URLSearchParams(await request.text());
      const token = form.get("token") ?? "";
      this.revokes.push(token);
      // 400: Linear can't revoke the token, such as one already revoked.
      if (!this.accepted.has(token)) return new Response(null, { status: 400 });
      this.accepted.delete(token);
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith("/upload/") && request.method === "PUT") {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => (headers[key] = value));
      this.puts.push({ url: request.url, headers, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  private async mint(request: Request): Promise<Response> {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    this.mints.push(form);
    const reply = this.mintReplies.shift();
    if (reply !== undefined) return reply.raw !== undefined ? new Response(reply.raw, { status: reply.status ?? 200 }) : Response.json(reply.data ?? {}, { status: reply.status ?? 200 });
    if (form.grant_type !== "client_credentials" || this.apps.get(form.client_id ?? "") !== form.client_secret) {
      return Response.json({ error: "invalid_client", error_description: "Client authentication failed" }, { status: 401 });
    }
    const token = `lin_oauth_${form.client_id}_${++this.tokens}`;
    this.accepted.add(token);
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: 2591999, scope: (form.scope ?? "").replaceAll(",", " ") });
  }

  private async graphql(request: Request): Promise<Response> {
    const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
    const document = parse(body.query);
    const operationAst = getOperationAST(document);
    const operation = operationAst?.name?.value ?? "(anonymous)";
    const variables = body.variables ?? {};
    const received: Received = { operation, query: body.query, variables, authorization: request.headers.get("authorization") };
    this.requests.push(received);

    const invalid = validate(linearSchema(), document);
    if (invalid.length > 0) return this.reply({ status: 400, errors: invalid.map((error) => ({ message: error.message, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } })) });
    const coerced = getVariableValues(linearSchema(), operationAst!.variableDefinitions ?? [], variables);
    if (coerced.errors !== undefined) return this.reply({ status: 400, errors: coerced.errors.map((error) => ({ message: error.message, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } })) });

    const authorization = received.authorization ?? "";
    if (!this.accepted.has(authorization.replace(/^Bearer /, ""))) return this.reply(UNAUTHENTICATED);
    const handler = this.queued.get(operation)?.shift() ?? this.handlers.get(operation);
    if (handler === undefined) throw new Error(`the fake Linear has no answer for ${operation}`);
    return this.reply(handler(variables, received));
  }

  private reply(reply: Reply): Response {
    const headers = { "Content-Type": "application/json", ...reply.headers };
    if (reply.raw !== undefined) return new Response(reply.raw, { status: reply.status ?? 200, headers: { ...reply.headers, "Content-Type": "text/html" } });
    const body: Record<string, unknown> = {};
    if (reply.data !== undefined) body.data = reply.data;
    if (reply.errors !== undefined) body.errors = reply.errors;
    return new Response(JSON.stringify(body), { status: reply.status ?? 200, headers });
  }
}
