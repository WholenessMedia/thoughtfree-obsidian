// Signing in: OAuth 2.1 with PKCE, as a public client. Nothing here is secret
// but the tokens, and they live in Obsidian's secret storage, not in data.json,
// which sits in the vault and travels with it.

import { base64url, type Http } from "./http.ts";

export type Endpoints = { origin: string; clientId: string; resource: string };

export const SCOPE = "vault.read offline_access";

export type Pending = { verifier: string; state: string; at: number };
export type Tokens = { access: string; refresh: string; expiresAt: number };

/** The two stores, handed in, so this runs under `node --test`. */
export type AuthStore = {
  loadTokens(): Tokens | null;
  saveTokens(tokens: Tokens | null): void;
  loadPending(): Pending | null;
  savePending(pending: Pending | null): void;
};

const PENDING_MS = 15 * 60 * 1000;
/** A token this close to its end is treated as ended. */
const EXPIRY_MARGIN_MS = 60 * 1000;

export class SignInNeeded extends Error {}

function randomText(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export class Auth {
  private refreshing: Promise<string> | null = null;
  private readonly redirect: string;

  constructor(
    private readonly at: Endpoints,
    private readonly store: AuthStore,
    private readonly http: Http,
    private readonly now: () => number = Date.now,
  ) {
    this.redirect = `${at.origin}/obsidian/return`;
  }

  get signedIn(): boolean {
    return this.store.loadTokens() !== null;
  }

  /** The address to open. Remembers what proves the answer is ours. */
  async begin(): Promise<string> {
    const verifier = randomText(48);
    const state = randomText(24);
    this.store.savePending({ verifier, state, at: this.now() });
    const query = new URLSearchParams({
      response_type: "code",
      client_id: this.at.clientId,
      redirect_uri: this.redirect,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
      state,
      scope: SCOPE,
      resource: this.at.resource,
    });
    return `${this.at.origin}/authorize?${query.toString()}`;
  }

  /**
   * Finish with a code that came back. [state] arrives with the link and is
   * checked; a pasted code has none, and is bound by the verifier alone, which
   * never left this device.
   */
  async finish(code: string, state?: string): Promise<void> {
    const pending = this.store.loadPending();
    if (!pending || this.now() - pending.at > PENDING_MS) {
      throw new Error("That sign-in has expired. Start again.");
    }
    if (state !== undefined && state !== pending.state) {
      throw new Error("That sign-in was not started here.");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: code.trim(),
      redirect_uri: this.redirect,
      client_id: this.at.clientId,
      code_verifier: pending.verifier,
      resource: this.at.resource,
    });
    const answer = await this.exchange(form);
    this.store.savePending(null);
    this.store.saveTokens(answer);
  }

  /** A token to use now, refreshed when needed. */
  async accessToken(): Promise<string> {
    const tokens = this.store.loadTokens();
    if (!tokens) throw new SignInNeeded();
    if (tokens.expiresAt - EXPIRY_MARGIN_MS > this.now()) return tokens.access;
    return this.refresh();
  }

  /**
   * ⚠️ One refresh at a time. A refresh token works once and using it twice
   * ends the connection, so two callers must share one exchange.
   */
  refresh(): Promise<string> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<string> {
    const tokens = this.store.loadTokens();
    if (!tokens) throw new SignInNeeded();
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
      client_id: this.at.clientId,
      resource: this.at.resource,
    });
    let answer: Tokens;
    try {
      answer = await this.exchange(form);
    } catch (err) {
      // A refused token will not get better. A failed network might.
      if (err instanceof Refused) {
        this.store.saveTokens(null);
        throw new SignInNeeded();
      }
      throw err;
    }
    this.store.saveTokens(answer);
    return answer.access;
  }

  /** Ends the connection here and on the server. The notes stay. */
  async signOut(): Promise<void> {
    const tokens = this.store.loadTokens();
    this.store.saveTokens(null);
    this.store.savePending(null);
    if (!tokens) return;
    try {
      await this.http({
        url: `${this.at.origin}/revoke`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh }).toString(),
      });
    } catch {
      // Offline: the tokens are gone from here, and Connected apps in the app
      // can end the rest.
    }
  }

  private async exchange(form: URLSearchParams): Promise<Tokens> {
    const res = await this.http({
      url: `${this.at.origin}/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (res.status === 400 || res.status === 401) throw new Refused();
    if (res.status !== 200) throw new Error("ThoughtFree did not answer. Try again shortly.");
    const data = res.json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data?.access_token || !data.refresh_token) throw new Refused();
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
    };
  }
}

/** The server said no, as opposed to not answering. */
export class Refused extends Error {
  constructor() {
    super("ThoughtFree refused that sign-in. Start again.");
  }
}
