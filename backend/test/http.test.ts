import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { devAuthenticator } from "../src/infra/auth.js";
import type { Config } from "../src/infra/config.js";
import { createHash } from "node:crypto";
import { cognitoAuthenticator } from "../src/infra/auth.js";
import { FakeIdentity, friedman, setup } from "./helpers.js";

const cfg: Config = {
  tableName: "t", region: "us-east-1", userPoolId: "p", cognitoClientId: "client123",
  cognitoDomain: "https://auth.example.com", publicBaseUrl: "https://shows.example.com", devAuth: true,
};

async function appFor(fetchFn?: typeof fetch) {
  const s = await setup();
  const idp = new FakeIdentity();
  const app = createApp({ cfg, svc: s.svc, authenticate: devAuthenticator, fetchFn, repo: s.repo, encryptor: s.encryptor, idp, googleSignIn: true });
  return { ...s, app, idp };
}
const post = (app: Awaited<ReturnType<typeof appFor>>["app"], path: string, body: unknown, user = "u1") =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-dev-user": user }, body: JSON.stringify(body) });

describe("public year in review", () => {
  it("opens without sign-in, is never cached, and 404s for unknown or revoked links", async () => {
    const { app } = await appFor();
    const made = await (await post(app, "/api/ops/create_event", { title: "Old show", date: "2020-05-05" })).json();
    await post(app, "/api/ops/set_rsvp", { eventId: made.result.event.id, status: "going" });
    const link = (await (await post(app, "/api/ops/create_review_link", { from: "2020-01-01", to: "2020-12-31" })).json()).result;
    const open = await app.request(`/api/public/review/${link.token}`);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe("no-store");
    expect((await open.json()).result.shows.map((x: { title: string }) => x.title)).toEqual(["Old show"]);
    expect((await app.request("/api/public/review/nope")).status).toBe(404);
    expect((await post(app, "/api/ops/revoke_review_link", { token: link.token }, "u2")).status).toBe(404);
    await post(app, "/api/ops/revoke_review_link", { token: link.token });
    expect((await app.request(`/api/public/review/${link.token}`)).status).toBe(404);
  });
});

describe("REST ops", () => {
  it("requires auth", async () => {
    const { app } = await appFor();
    const r = await app.request("/api/ops/list_events", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("runs ops, validates input, maps errors", async () => {
    const { app } = await appFor();
    const created = await (await post(app, "/api/ops/create_event", friedman)).json();
    expect(created.ok).toBe(true);
    const id = created.result.event.id;
    expect((await post(app, "/api/ops/create_event", { title: "no date" })).status).toBe(400);
    expect((await post(app, "/api/ops/get_event", { eventId: "nope" })).status).toBe(404);
    expect((await post(app, "/api/ops/nope", {})).status).toBe(404);
    const rsvp = await (await post(app, "/api/ops/set_rsvp", { eventId: id, status: "going" })).json();
    expect(rsvp.result.rsvp.status).toBe("going");
    // another user does not see it
    const other = await (await post(app, "/api/ops/list_events", {}, "u2")).json();
    expect(other.result.total).toBe(0);
  });
});

const json = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");
const VERIFIER = "v".repeat(50);

describe("password sign-in API", () => {
  it("signs up, confirms with the emailed code, then logs in", async () => {
    const { app } = await appFor();
    expect((await json(app, "/api/auth/signup", { email: "Me@Example.com", password: "short" })).status).toBe(400);
    const su = await json(app, "/api/auth/signup", { email: "Me@Example.com", password: "a-long-password-1" });
    expect((await su.json()).needsConfirmation).toBe(true);
    const early = await json(app, "/api/auth/login", { email: "me@example.com", password: "a-long-password-1" });
    expect(early.status).toBe(403);
    expect((await early.json()).code).toBe("unconfirmed");
    expect((await json(app, "/api/auth/confirm", { email: "me@example.com", code: "000000" })).status).toBe(400);
    expect((await json(app, "/api/auth/confirm", { email: "me@example.com", code: "123456" })).status).toBe(200);
    const ok = await (await json(app, "/api/auth/login", { email: "me@example.com", password: "a-long-password-1" })).json();
    expect(ok.tokens).toMatchObject({ accessToken: "access-me@example.com", refreshToken: "refresh-me@example.com" });
    const bad = await json(app, "/api/auth/login", { email: "me@example.com", password: "nope" });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe("Incorrect email or password.");
    expect((await json(app, "/api/auth/signup", { email: "me@example.com", password: "a-long-password-1" })).status).toBe(409);
  });

  it("resets a forgotten password without revealing whether the account exists", async () => {
    const { app, idp } = await appFor();
    await json(app, "/api/auth/signup", { email: "me@example.com", password: "a-long-password-1" });
    await json(app, "/api/auth/confirm", { email: "me@example.com", code: "123456" });
    expect((await json(app, "/api/auth/forgot", { email: "ghost@example.com" })).status).toBe(200);
    expect((await json(app, "/api/auth/forgot", { email: "me@example.com" })).status).toBe(200);
    expect((await json(app, "/api/auth/reset", { email: "me@example.com", code: "654321", password: "brand-new-pass-2" })).status).toBe(200);
    expect(idp.users.get("me@example.com")?.password).toBe("brand-new-pass-2");
  });

  it("refreshes a session and rejects junk input", async () => {
    const { app } = await appFor();
    expect((await (await json(app, "/api/auth/refresh", { refreshToken: "refresh-me@example.com" })).json()).tokens.accessToken).toBe("access2-me@example.com");
    expect((await json(app, "/api/auth/refresh", { refreshToken: "junk" })).status).toBe(401);
    expect((await json(app, "/api/auth/login", { email: "not-an-email", password: "x" })).status).toBe(400);
    expect((await json(app, "/api/auth/nope", {})).status).toBe(404);
  });

  it("tells the login page whether Google is offered", async () => {
    const { app } = await appFor();
    expect((await (await app.request("/api/config")).json()).googleSignIn).toBe(true);
  });
});

describe("OAuth server for MCP clients", () => {
  async function register(app: any, uris = ["https://claude.ai/api/mcp/auth_callback"]) {
    const reg = await json(app, "/register", { redirect_uris: uris, client_name: "Claude" });
    expect(reg.status).toBe(201);
    return (await reg.json()).client_id as string;
  }
  const authorize = (app: any, clientId: string, extra: Record<string, string> = {}) =>
    app.request("/authorize?" + new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "st1",
      code_challenge: challengeOf(VERIFIER), code_challenge_method: "S256", ...extra,
    }));

  it("advertises our own authorize and token endpoints", async () => {
    const { app } = await appFor();
    const meta = await (await app.request("/.well-known/oauth-authorization-server")).json();
    expect(meta.authorization_endpoint).toBe("https://shows.example.com/authorize");
    expect(meta.token_endpoint).toBe("https://shows.example.com/token");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect((await (await app.request("/.well-known/oauth-protected-resource")).json()).resource).toBe("https://shows.example.com/mcp");
  });

  it("runs the whole flow: register, authorize, login page handoff, complete, token, refresh, then MCP works with the token", async () => {
    const { app } = await appFor();
    const clientId = await register(app);
    const res = await authorize(app, clientId);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://shows.example.com/login");
    const handle = loc.searchParams.get("authreq")!;

    // the SPA finishes the request after the user logs in
    expect((await json(app, "/api/oauth/complete", { handle })).status).toBe(401);
    const done = await (await json(app, "/api/oauth/complete", { handle, refreshToken: "refresh-me@example.com" }, { authorization: "Bearer access-me@example.com", "x-dev-user": "me@example.com" })).json();
    const back = new URL(done.redirectUrl);
    expect(back.origin + back.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(back.searchParams.get("state")).toBe("st1");
    const code = back.searchParams.get("code")!;
    // the handle is single use
    expect((await json(app, "/api/oauth/complete", { handle }, { authorization: "Bearer access-me@example.com", "x-dev-user": "me@example.com" })).status).toBe(410);

    const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
    const base = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback" };
    expect((await app.request("/token", form({ ...base, code_verifier: "w".repeat(50) }))).status).toBe(400); // wrong verifier burns the code
    expect((await app.request("/token", form({ ...base, code_verifier: VERIFIER }))).status).toBe(400);

    const again = (await (await json(app, "/api/oauth/complete", { handle: new URL((await authorize(app, clientId)).headers.get("location")!).searchParams.get("authreq")!, refreshToken: "refresh-me@example.com" }, { authorization: "Bearer access-me@example.com", "x-dev-user": "me@example.com" })).json());
    const code2 = new URL(again.redirectUrl).searchParams.get("code")!;
    const tok = await app.request("/token", form({ ...base, code: code2, code_verifier: VERIFIER }));
    expect(tok.status).toBe(200);
    expect(await tok.json()).toMatchObject({ access_token: "access-me@example.com", refresh_token: "refresh-me@example.com", token_type: "Bearer" });
    expect((await app.request("/token", form({ ...base, code: code2, code_verifier: VERIFIER }))).status).toBe(400); // replay

    const ref = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: "refresh-me@example.com" }));
    expect((await ref.json()).access_token).toBe("access2-me@example.com");
    expect((await app.request("/token", form({ grant_type: "refresh_token", refresh_token: "bad" }))).status).toBe(400);
  });

  it("never redirects to an unregistered address and requires PKCE", async () => {
    const { app } = await appFor();
    const clientId = await register(app);
    expect((await authorize(app, clientId, { redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    expect((await authorize(app, "unknown")).status).toBe(400);
    const noPkce = await authorize(app, clientId, { code_challenge_method: "plain" });
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers.get("location")).toContain("error=invalid_request");
    expect((await json(app, "/register", { redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await json(app, "/register", { redirect_uris: [] })).status).toBe(400);
  });

  it("accepts any port for registered loopback redirects", async () => {
    const { app } = await appFor();
    const clientId = await register(app, ["http://localhost:1234/callback"]);
    const r = await authorize(app, clientId, { redirect_uri: "http://localhost:50999/callback" });
    expect(r.status).toBe(302);
  });

  it("challenges unauthenticated MCP calls with the resource metadata pointer", async () => {
    const { app } = await appFor();
    const r = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('resource_metadata="https://shows.example.com/.well-known/oauth-protected-resource"');
  });
});

describe("Cognito token authenticator", () => {
  it("rejects tokens whose email is not verified", async () => {
    const idp = new FakeIdentity();
    idp.getUser = async () => ({ email: "x@example.com", emailVerified: false, name: undefined });
    const auth = cognitoAuthenticator({ ...cfg, devAuth: false }, idp);
    await expect(auth("not-a-jwt", new Headers())).rejects.toThrow();
  });
});

describe("MCP over HTTP", () => {
  it("lists every operation as a tool and drives a full add -> RSVP flow", async () => {
    const { app, calendar } = await appFor();
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { "x-dev-user": "u1" } },
      fetch: ((url: string | URL, init?: RequestInit) => app.request(String(url), init as RequestInit)) as typeof fetch,
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["retire_venue", "unretire_venue", "bulk_create_events", "create_event", "set_rsvp", "list_events", "calendar_connect", "calendar_select", "update_event", "delete_event", "share_rsvp", "get_stats", "merge_venues"]) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => /review/.test(n))).toEqual([]); // year in review is web-only
    expect(tools.find((t) => t.name === "delete_event")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "list_events")?.annotations?.readOnlyHint).toBe(true);

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return { error: r.isError, data: JSON.parse((r.content as Array<{ text: string }>)[0]!.text.startsWith("{") || (r.content as Array<{ text: string }>)[0]!.text.startsWith("[") ? (r.content as Array<{ text: string }>)[0]!.text : "null"), text: (r.content as Array<{ text: string }>)[0]!.text };
    };
    const bulk = await call("bulk_create_events", { events: [friedman, { title: "Second", date: "2026-12-05" }] });
    expect(bulk.data.created).toHaveLength(2);
    const undecided = await call("list_events", { rsvp: "none" });
    expect(undecided.data.total).toBe(2);
    const id = undecided.data.events[0].id;
    const rsvp = await call("set_rsvp", { eventId: id, status: "going" });
    expect(rsvp.data.rsvp.status).toBe("going");
    expect(rsvp.data.calendar.status).toBe("skipped");
    const bad = await call("set_rsvp", { eventId: "nope", status: "going" });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/not found/);
    const connect = await call("calendar_connect", {});
    expect(connect.data.url).toContain("state=");
    expect(calendar.events.size).toBe(0);
    await client.close();
  });
});
