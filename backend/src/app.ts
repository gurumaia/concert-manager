import { Hono } from "hono";
import { buildGoogleAuthUrl, exchangeGoogleCode, type GoogleConfig } from "./infra/google.js";
import { AuthError, type Authenticator } from "./infra/auth.js";
import type { Config } from "./infra/config.js";
import { AppError, type Ctx, type Service } from "./domain/service.js";
import { errorText, handleMcpRequest } from "./mcp.js";
import { opsByName } from "./ops.js";
import { ZodError, z } from "zod";
import type { Repo } from "./domain/repo.js";
import type { Encryptor } from "./infra/crypto.js";
import { IdentityError, type IdentityApi } from "./infra/identity.js";
import {
  AUTHREQ_TTL_MS, CLIENT_TTL_MS, CODE_TTL_MS, isValidRedirectUri, pkceMatches, randomToken, redirectUriMatches, withParams,
  type AuthRequest, type CodeGrant, type Registration,
} from "./mcpOauth.js";

export type AppDeps = {
  cfg: Config;
  svc: Service;
  authenticate: Authenticator;
  google?: GoogleConfig;
  fetchFn?: typeof fetch;
  repo: Repo;
  encryptor: Encryptor;
  idp: IdentityApi;
  /** Cognito has a Google identity provider, so the login page can offer it. */
  googleSignIn?: boolean;
};

type Env = { Variables: { ctx: Ctx } };

const SCOPES = "openid email profile";

export function createApp(d: AppDeps) {
  const app = new Hono<Env>();
  // Behind CloudFront the Lambda sees its own function-URL host; a CloudFront Function copies the viewer host to x-original-host.
  const base = (c: { req: { url: string; header: (n: string) => string | undefined } }) => {
    if (d.cfg.publicBaseUrl) return d.cfg.publicBaseUrl;
    const fwd = c.req.header("x-original-host");
    return fwd ? `https://${fwd}` : new URL(c.req.url).origin;
  };
  const fetchFn = d.fetchFn ?? fetch;

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------- OAuth server for MCP clients (claude.ai)
  // The login page is this app's own (/login). Claude registers dynamically, is sent to /authorize, which hands the browser to
  // /login?authreq=<handle>; once the user is signed in the SPA calls /api/oauth/complete and Claude receives a one-time code
  // that /token swaps for the user's Cognito tokens (PKCE S256 required).
  const protectedResource = (c: Parameters<typeof base>[0]) => ({
    resource: `${base(c)}/mcp`,
    authorization_servers: [base(c)],
    scopes_supported: SCOPES.split(" "),
    bearer_methods_supported: ["header"],
  });
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource(c)));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource(c)));
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: base(c),
      authorization_endpoint: `${base(c)}/authorize`,
      token_endpoint: `${base(c)}/token`,
      registration_endpoint: `${base(c)}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES.split(" "),
    }),
  );

  const oauthError = (c: any, status: number, error: string, description: string) =>
    c.json({ error, error_description: description }, status, { "cache-control": "no-store" });

  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: string };
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(isValidRedirectUri)) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris must be 1-10 https (or loopback http) URIs");
    }
    const clientId = randomToken(18);
    const reg: Registration = { redirectUris: uris as string[], clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined };
    await d.repo.putTemp(`client:${clientId}`, reg, Date.now() + CLIENT_TTL_MS);
    return c.json({
      client_id: clientId, client_name: reg.clientName, redirect_uris: reg.redirectUris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    }, 201);
  });

  app.get("/authorize", async (c) => {
    const q = c.req.query();
    const reg = q.client_id ? await d.repo.getTemp<Registration>(`client:${q.client_id}`) : undefined;
    // Never redirect to an unregistered URI: report the problem on this page instead.
    if (!reg || !q.redirect_uri || !redirectUriMatches(q.redirect_uri, reg.redirectUris)) {
      return c.text("This sign-in link is not valid: unknown client or redirect address. Remove and re-add the connector in Claude.", 400);
    }
    const fail = (error: string, description: string) => c.redirect(withParams(q.redirect_uri!, { error, error_description: description, state: q.state }));
    if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    const handle = randomToken(24);
    const req: AuthRequest = { clientId: q.client_id!, redirectUri: q.redirect_uri, state: q.state, codeChallenge: q.code_challenge };
    await d.repo.putTemp(`authreq:${handle}`, req, Date.now() + AUTHREQ_TTL_MS);
    return c.redirect(`${base(c)}/login?authreq=${handle}`);
  });

  const tokenBody = (t: { accessToken: string; refreshToken?: string; expiresIn: number }) => ({
    access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, ...(t.refreshToken ? { refresh_token: t.refreshToken } : {}), scope: SCOPES,
  });

  app.post("/token", async (c) => {
    const form = new URLSearchParams(await c.req.text());
    const noStore = { "cache-control": "no-store" };
    if (form.get("grant_type") === "refresh_token") {
      const rt = form.get("refresh_token");
      if (!rt) return oauthError(c, 400, "invalid_request", "refresh_token is required");
      try {
        return c.json(tokenBody(await d.idp.refresh(rt)), 200, noStore);
      } catch {
        return oauthError(c, 400, "invalid_grant", "The refresh token is no longer valid");
      }
    }
    if (form.get("grant_type") !== "authorization_code") return oauthError(c, 400, "unsupported_grant_type", "Unsupported grant_type");
    const code = form.get("code");
    const grant = code ? await d.repo.takeTemp<CodeGrant>(`code:${code}`) : undefined; // one-time
    if (!grant || grant.clientId !== form.get("client_id") || grant.redirectUri !== form.get("redirect_uri") || !pkceMatches(form.get("code_verifier") ?? "", grant.codeChallenge)) {
      return oauthError(c, 400, "invalid_grant", "The authorization code is invalid or expired");
    }
    const tokens = JSON.parse(await d.encryptor.decrypt(grant.tokensEnc)) as { accessToken: string; refreshToken?: string; expiresIn: number };
    return c.json(tokenBody(tokens), 200, noStore);
  });

  // ---------------------------------------------------------------- email + password sign-in (the app's own login page)
  const emailSchema = z.string().trim().toLowerCase().email().max(254);
  const passwordSchema = z.string().min(1).max(256);
  const codeSchema = z.string().trim().min(4).max(10);
  const authRoutes: Record<string, { body: z.ZodObject<any>; run: (b: any) => Promise<unknown> }> = {
    login: { body: z.object({ email: emailSchema, password: passwordSchema }), run: async (b) => ({ tokens: await d.idp.login(b.email, b.password) }) },
    signup: {
      body: z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().max(100).optional() }),
      run: async (b) => { await d.idp.signUp(b.email, b.password, b.name || undefined); return { needsConfirmation: true }; },
    },
    confirm: { body: z.object({ email: emailSchema, code: codeSchema }), run: async (b) => { await d.idp.confirmSignUp(b.email, b.code); return {}; } },
    resend: { body: z.object({ email: emailSchema }), run: async (b) => { await d.idp.resendCode(b.email); return {}; } },
    forgot: { body: z.object({ email: emailSchema }), run: async (b) => { await d.idp.forgotPassword(b.email); return {}; } },
    reset: {
      body: z.object({ email: emailSchema, code: codeSchema, password: passwordSchema }),
      run: async (b) => { await d.idp.confirmForgotPassword(b.email, b.code, b.password); return {}; },
    },
    refresh: { body: z.object({ refreshToken: z.string().min(1) }), run: async (b) => ({ tokens: await d.idp.refresh(b.refreshToken) }) },
  };
  app.post("/api/auth/:action", async (c) => {
    const route = authRoutes[c.req.param("action")];
    if (!route) return c.json({ ok: false, error: "unknown action" }, 404);
    const parsed = route.body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, code: "invalid", error: "Please check the details and try again." }, 400);
    try {
      return c.json({ ok: true, ...(await route.run(parsed.data) as object) }, 200, { "cache-control": "no-store" });
    } catch (e) {
      if (e instanceof IdentityError) return c.json({ ok: false, code: e.code, error: e.message }, e.status as 400);
      console.error("auth failed", errorText(e));
      return c.json({ ok: false, code: "error", error: "Something went wrong. Please try again." }, 500);
    }
  });

  // ---------------------------------------------------------------- public config for the SPA
  app.get("/api/config", (c) =>
    c.json({
      cognitoDomain: d.cfg.cognitoDomain, clientId: d.cfg.cognitoClientId, scopes: SCOPES, devAuth: d.cfg.devAuth,
      googleConfigured: !!d.google, googleSignIn: !!d.googleSignIn,
    }),
  );

  // ---------------------------------------------------------------- Google Calendar OAuth callback (browser redirect)
  app.get("/api/google/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const back = (q: string) => c.redirect(`${base(c)}/settings?${q}`);
    if (c.req.query("error") || !state || !code || !d.google) return back("calendar=denied");
    try {
      const { refreshToken, email } = await exchangeGoogleCode(d.google, code, `${base(c)}/api/google/callback`);
      await d.svc.completeCalendarConnect(state, refreshToken, email);
      return back("calendar=connected");
    } catch (e) {
      console.error("google callback failed", errorText(e));
      return back("calendar=error");
    }
  });

  // ---------------------------------------------------------------- authenticated routes
  const auth = (kind: "api" | "mcp") =>
    async (c: any, next: () => Promise<void>) => {
      const header = c.req.header("authorization") ?? "";
      const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      try {
        if (!token && !d.cfg.devAuth) throw new AuthError("Missing bearer token");
        const ctx = { ...(await d.authenticate(token, c.req.raw.headers)), baseUrl: base(c) };
        c.set("ctx", ctx);
        await d.svc.ensureUser(ctx);
      } catch (e) {
        if (!(e instanceof AuthError)) console.error("auth failure", errorText(e));
        const challenge = kind === "mcp" ? { "www-authenticate": `Bearer resource_metadata="${base(c)}/.well-known/oauth-protected-resource"` } : {};
        return c.json({ error: "unauthorized", message: e instanceof AuthError ? e.message : "Sign-in failed" }, 401, challenge);
      }
      await next();
    };

  app.use("/mcp", auth("mcp"));
  app.all("/mcp", (c) => {
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return handleMcpRequest(d.svc, c.get("ctx"), c.req.raw);
  });

  app.use("/api/ops/*", auth("api"));
  app.post("/api/ops/:name", async (c) => {
    const op = opsByName.get(c.req.param("name"));
    if (!op) return c.json({ ok: false, error: "unknown operation" }, 404);
    const raw = await c.req.json().catch(() => ({}));
    try {
      const input = op.input.parse(raw ?? {});
      return c.json({ ok: true, result: await op.run(d.svc, c.get("ctx"), input) });
    } catch (e) {
      if (e instanceof ZodError) return c.json({ ok: false, error: "invalid input", issues: e.issues }, 400);
      if (e instanceof AppError) {
        const status = { not_found: 404, invalid: 400, conflict: 409, unauthorized: 401, calendar: 424 }[e.code];
        return c.json({ ok: false, error: e.message }, status as 400);
      }
      console.error("op failed", op.name, e);
      return c.json({ ok: false, error: "internal error" }, 500);
    }
  });

  // The signed-in SPA finishes an MCP authorization: swaps the pending request for a one-time code for Claude.
  app.use("/api/oauth/*", auth("api"));
  app.post("/api/oauth/complete", async (c) => {
    const body = z.object({ handle: z.string().min(1), refreshToken: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ ok: false, error: "invalid input" }, 400);
    const req = await d.repo.takeTemp<AuthRequest>(`authreq:${body.data.handle}`);
    if (!req) return c.json({ ok: false, error: "This connection request expired. Start again from Claude." }, 410);
    const accessToken = (c.req.header("authorization") ?? "").slice(7).trim();
    const tokens = { accessToken, refreshToken: body.data.refreshToken, expiresIn: 3600 };
    const code = randomToken(32);
    const grant: CodeGrant = { ...req, userId: c.get("ctx").userId, tokensEnc: await d.encryptor.encrypt(JSON.stringify(tokens)) };
    await d.repo.putTemp(`code:${code}`, grant, Date.now() + CODE_TTL_MS);
    return c.json({ ok: true, redirectUrl: withParams(req.redirectUri, { code, state: req.state }) });
  });

  return app;
}

export { buildGoogleAuthUrl };
