import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Auth, SignInNeeded, type AuthStore, type Pending, type Tokens } from "../src/auth.ts";
import type { Http, HttpRequest } from "../src/http.ts";
import { jsonResponse } from "./fake.ts";

const AT = {
  origin: "https://mcp.example",
  clientId: "https://mcp.example/clients/obsidian",
  resource: "https://mcp.example/vault",
};

function store(tokens: Tokens | null = null) {
  const s = {
    tokens,
    pending: null as Pending | null,
    loadTokens: () => s.tokens,
    saveTokens: (t: Tokens | null) => void (s.tokens = t),
    loadPending: () => s.pending,
    savePending: (p: Pending | null) => void (s.pending = p),
  };
  return s satisfies AuthStore;
}

const form = (r: HttpRequest) => new URLSearchParams(r.body);
const granted = jsonResponse(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 });

test("begin asks for read only, with PKCE, for the feed", async () => {
  const s = store();
  const url = new URL(await new Auth(AT, s, async () => granted).begin());
  assert.equal(url.pathname, "/authorize");
  const q = url.searchParams;
  assert.equal(q.get("scope"), "vault.read offline_access");
  assert.equal(q.get("resource"), AT.resource);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), "https://mcp.example/obsidian/return");
  assert.equal(q.get("state"), s.pending!.state);
  const expected = createHash("sha256").update(s.pending!.verifier).digest("base64url");
  assert.equal(q.get("code_challenge"), expected);
  assert.ok(s.pending!.verifier.length >= 43);
});

test("finish sends the verifier and keeps the tokens", async () => {
  const s = store();
  const seen: HttpRequest[] = [];
  const auth = new Auth(AT, s, async (r) => (seen.push(r), granted));
  await auth.begin();
  const { verifier, state } = s.pending!;
  await auth.finish(" code-1 ", state);
  assert.equal(form(seen[0]!).get("code"), "code-1");
  assert.equal(form(seen[0]!).get("code_verifier"), verifier);
  assert.equal(form(seen[0]!).get("resource"), AT.resource);
  assert.equal(s.tokens!.access, "a2");
  assert.equal(s.pending, null);
});

test("a code with the wrong state is refused before anything is sent", async () => {
  const s = store();
  let sent = 0;
  const auth = new Auth(AT, s, async () => (sent++, granted));
  await auth.begin();
  await assert.rejects(auth.finish("code", "not-ours"));
  assert.equal(sent, 0);
  assert.equal(s.tokens, null);
});

test("a pasted code has no state, and is bound by the verifier", async () => {
  const s = store();
  const auth = new Auth(AT, s, async () => granted);
  await auth.begin();
  await auth.finish("code");
  assert.equal(s.tokens!.refresh, "r2");
});

test("a sign-in left open too long has to start again", async () => {
  const s = store();
  let now = 0;
  const auth = new Auth(AT, s, async () => granted, () => now);
  await auth.begin();
  now = 16 * 60 * 1000;
  await assert.rejects(auth.finish("code"));
});

test("a code nobody asked for is refused", async () => {
  await assert.rejects(new Auth(AT, store(), async () => granted).finish("code"));
});

test("two callers share one refresh, because a token works once", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: 0 });
  let calls = 0;
  const http: Http = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return granted;
  };
  const auth = new Auth(AT, s, http);
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(calls, 1);
  assert.equal(a, "a2");
  assert.equal(b, "a2");
});

test("a live token is used without asking", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: Date.now() + 600_000 });
  assert.equal(await new Auth(AT, s, async () => { throw new Error("no"); }).accessToken(), "a1");
});

test("a refused refresh signs out", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: 0 });
  await assert.rejects(new Auth(AT, s, async () => jsonResponse(400, {})).accessToken(),
    (e: unknown) => e instanceof SignInNeeded);
  assert.equal(s.tokens, null);
});

test("a dropped network keeps the tokens", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: 0 });
  await assert.rejects(new Auth(AT, s, async () => { throw new Error("offline"); }).accessToken());
  assert.equal(s.tokens!.refresh, "r1");
});

test("a 500 keeps the tokens", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: 0 });
  await assert.rejects(new Auth(AT, s, async () => jsonResponse(500, {})).accessToken());
  assert.equal(s.tokens!.refresh, "r1");
});

test("no tokens means sign in", async () => {
  await assert.rejects(new Auth(AT, store(), async () => granted).accessToken(),
    (e: unknown) => e instanceof SignInNeeded);
});

test("sign out clears here first, and offline still clears", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: 0 });
  await new Auth(AT, s, async () => { throw new Error("offline"); }).signOut();
  assert.equal(s.tokens, null);
});

test("sign out tells the server", async () => {
  const s = store({ access: "a1", refresh: "r1", expiresAt: 0 });
  const seen: HttpRequest[] = [];
  await new Auth(AT, s, async (r) => (seen.push(r), jsonResponse(200, {}))).signOut();
  assert.equal(seen[0]!.url, "https://mcp.example/revoke");
  assert.equal(form(seen[0]!).get("token"), "r1");
});
