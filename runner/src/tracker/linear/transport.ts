// How the Linear adapter reaches Linear: GraphQL at `<api>/graphql`, the client-credentials grant at
// `<api>/oauth/token`, and revokes at `<api>/oauth/revoke` (spec 1, "Tokens", ADR 0005). Every answer is sorted
// into one of three outcomes: data, a call Linear didn't take (`TrackerUnavailable`: a network error, a 5xx, or
// `RATELIMITED`), or a call Linear refused (`TrackerRefused`). A 401 on the runner's token drops it, mints a
// new one, and tries the call once more.
import { MintFailed, type LinearApp } from "../mint.ts";
import { TrackerRefused } from "../refused.ts";
import { TrackerUnavailable } from "../unavailable.ts";

/** One OAuth app's client ID and secret. */
export interface AppSecret {
  id: string;
  secret: string;
}

/** A workspace's two apps, from `credentials.env`. Reader is `null` when the file lacks its keys. */
export interface LinearApps {
  flight_deck: AppSecret | null;
  reader: AppSecret | null;
}

/**
 * Whom the adapter acts as. The runner acts as the Flight Deck app, with a token it mints per workspace.
 * `flight-deck apply` acts as the maintainer, with the setup key of the record's workspace (ADRs 0007 and 0017).
 */
export type LinearIdentity = { kind: "flight_deck" } | { kind: "setup_key"; key: string };

export interface TransportOptions {
  identity: LinearIdentity;
  /** The workspace's apps, read at each mint, so a rotated secret takes effect at the next mint. */
  apps: (workspace: string) => Promise<LinearApps | null>;
  /** Linear's origin. Tests point it at a local server. */
  api: string;
  fetch: typeof fetch;
  timeoutMs: number;
  log: (message: string) => void;
}

/** One GraphQL error as Linear sends it. */
export interface GraphqlError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

/** What a GraphQL call returned when it isn't a call Linear didn't take. */
export interface GraphqlAnswer<T> {
  data: T | null;
  errors: GraphqlError[];
}

export interface GraphqlOptions {
  /** Keep data that came back beside errors, as a read of issues on teams the app can't read does. */
  partial?: boolean;
  /** Return a "not found" error as an answer instead of throwing, so `issue` can throw `IssueNotFoundError`. */
  notFound?: boolean;
}

const MINT_SCOPES: Record<LinearApp, string> = { flight_deck: "read,write", reader: "read" };
const APP_NAMES: Record<LinearApp, string> = { flight_deck: "Flight Deck", reader: "Flight Deck Reader" };

/**
 * Whether a GraphQL error says the entity doesn't exist, or the identity can't see it. Linear answers
 * "Entity not found: Issue"; the contract suite pins the message and code.
 */
export function isNotFound(error: GraphqlError): boolean {
  return /entity not found|could not find referenced/i.test(`${error.message} ${error.extensions?.userPresentableMessage ?? ""}`);
}

export class Transport {
  /** The runner's Flight Deck token for each workspace. It lives only in memory (ADR 0005). */
  private readonly tokens = new Map<string, string>();

  constructor(private readonly options: TransportOptions) {}

  /**
   * A GraphQL call for the workspace, as the adapter's identity. Throws `TrackerUnavailable` for a call Linear
   * didn't take and `TrackerRefused` for any error the answer holds, unless `options` keeps it.
   */
  async graphql<T>(workspace: string, query: string, variables: Record<string, unknown>, options: GraphqlOptions = {}): Promise<GraphqlAnswer<T>> {
    const identity = this.options.identity;
    if (identity.kind === "setup_key") {
      const answer = await this.post<T>(identity.key, query, variables);
      if (answer === "unauthorized") throw new TrackerRefused(`Linear rejected the setup key for ${workspace}`);
      return this.checked(answer, options);
    }
    let answer = await this.post<T>(`Bearer ${await this.appToken(workspace)}`, query, variables);
    if (answer === "unauthorized") {
      // An expired or revoked token answers 401: mint a new one and try once more (ADR 0005).
      this.tokens.delete(workspace);
      answer = await this.post<T>(`Bearer ${await this.appToken(workspace)}`, query, variables);
      if (answer === "unauthorized") throw new MintFailed("flight_deck", workspace, `Linear rejected a new Flight Deck token for ${workspace}`);
    }
    return this.checked(answer, options);
  }

  /** Whether Linear takes the token, by a `viewer` query (spec 1, "Session credentials"). */
  async accepts(token: string): Promise<boolean> {
    const answer = await this.post<{ viewer: { id: string } | null }>(`Bearer ${token}`, "query FlightDeckViewer { viewer { id } }", {});
    return answer !== "unauthorized" && answer.errors.length === 0 && answer.data?.viewer != null;
  }

  /** Mints the runner's token for the workspace when it holds none. A setup key needs no token. */
  async runnerToken(workspace: string): Promise<void> {
    if (this.options.identity.kind === "setup_key") return;
    await this.appToken(workspace);
  }

  /** Forgets the runner's token for the workspace and revokes it. A failed revoke is logged, never thrown. */
  async revokeRunnerToken(workspace: string): Promise<void> {
    const token = this.tokens.get(workspace);
    this.tokens.delete(workspace);
    if (token !== undefined) await this.revoke(token);
  }

  /** Mints a token from one of the workspace's apps with the client-credentials grant, or throws `MintFailed`. */
  async mint(app: LinearApp, workspace: string): Promise<string> {
    const secret = (await this.options.apps(workspace))?.[app] ?? null;
    if (secret === null) throw new MintFailed(app, workspace, `credentials.env has no ${APP_NAMES[app]} app for ${workspace}`);
    let response: Response;
    try {
      response = await this.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: MINT_SCOPES[app], client_id: secret.id, client_secret: secret.secret }).toString(),
      });
    } catch (error) {
      throw new MintFailed(app, workspace, `Linear didn't answer a ${APP_NAMES[app]} token mint for ${workspace}: ${message(error)}`);
    }
    const body = (await response.json().catch(() => null)) as { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!response.ok || typeof body?.access_token !== "string" || body.access_token === "") {
      const reason = [body?.error, body?.error_description].filter((each) => typeof each === "string" && each !== "").join(": ");
      throw new MintFailed(app, workspace, `Linear refused to mint a ${APP_NAMES[app]} token for ${workspace}: HTTP ${response.status}${reason === "" ? "" : ` ${reason}`}`);
    }
    return body.access_token;
  }

  /** Revokes a token with `POST /oauth/revoke`. A failed revoke is logged: the token expires within 30 days. */
  async revoke(token: string): Promise<void> {
    try {
      const response = await this.request("/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
      });
      // 400 means Linear can't revoke it, such as a token already revoked, which leaves nothing to do.
      if (!response.ok && response.status !== 400) this.options.log(`Linear token revoke answered HTTP ${response.status}`);
    } catch (error) {
      this.options.log(`Linear token revoke failed: ${message(error)}`);
    }
  }

  /** A PUT of a file to the signed upload URL `fileUpload` returned. */
  async put(url: string, headers: Record<string, string>, data: Uint8Array): Promise<void> {
    let response: Response;
    try {
      response = await this.request(url, { method: "PUT", headers, body: data });
    } catch (error) {
      throw new TrackerUnavailable("network", `Linear's upload didn't answer: ${message(error)}`);
    }
    if (response.status === 429) throw new TrackerUnavailable("rate_limited", "Linear's upload answered 429");
    if (response.status >= 500) throw new TrackerUnavailable("server", `Linear's upload answered HTTP ${response.status}`);
    if (!response.ok) throw new TrackerRefused(`Linear's upload answered HTTP ${response.status}`);
  }

  private async appToken(workspace: string): Promise<string> {
    const held = this.tokens.get(workspace);
    if (held !== undefined) return held;
    const token = await this.mint("flight_deck", workspace);
    this.tokens.set(workspace, token);
    return token;
  }

  /** One GraphQL POST. Returns `"unauthorized"` for a 401 or an authentication error. */
  private async post<T>(authorization: string, query: string, variables: Record<string, unknown>): Promise<GraphqlAnswer<T> | "unauthorized"> {
    let response: Response;
    try {
      response = await this.request("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new TrackerUnavailable("network", `Linear didn't answer: ${message(error)}`);
    }
    const body = (await response.json().catch(() => null)) as { data?: T | null; errors?: GraphqlError[] } | null;
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const codes = errors.map((error) => error.extensions?.code);
    if (response.status === 429 || codes.includes("RATELIMITED")) throw new TrackerUnavailable("rate_limited", "Linear answered RATELIMITED");
    if (response.status >= 500) throw new TrackerUnavailable("server", `Linear answered HTTP ${response.status}`);
    if (response.status === 401 || codes.includes("AUTHENTICATION_ERROR")) return "unauthorized";
    if (body === null) throw new TrackerUnavailable("server", `Linear answered HTTP ${response.status} with no JSON`);
    return { data: body.data ?? null, errors };
  }

  private checked<T>(answer: GraphqlAnswer<T>, options: GraphqlOptions): GraphqlAnswer<T> {
    if (answer.errors.length === 0 && answer.data !== null) return answer;
    if (options.notFound === true && answer.errors.some(isNotFound)) return answer;
    if (options.partial === true && answer.data !== null) return answer;
    const text = answer.errors.map((error) => error.extensions?.userPresentableMessage ?? error.message).join("; ");
    throw new TrackerRefused(`Linear refused the call: ${text === "" ? "no data" : text}`);
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith("/") ? `${this.options.api}${path}` : path;
    return this.options.fetch(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs) });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
