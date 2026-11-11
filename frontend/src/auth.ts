// Sign-in. The login page is this app's own: email + password go to our API, Google goes through Cognito's redirect
// (straight to Google, Cognito shows no page of its own).
export type AppConfig = { cognitoDomain: string; clientId: string; scopes: string; devAuth: boolean; googleConfigured: boolean; googleSignIn: boolean };
type Tokens = { access: string; refresh?: string; expiresAt: number };
export type ApiTokens = { accessToken: string; refreshToken?: string; expiresIn: number };

const TOKENS = "sm.tokens";
const VERIFIER = "sm.pkce";
const RETURN_TO = "sm.returnTo";
const AUTHREQ = "sm.authreq";
const DEV_USER = "sm.devUser";

let configPromise: Promise<AppConfig> | undefined;
export const getConfig = () => (configPromise ??= fetch("/api/config").then((r) => r.json() as Promise<AppConfig>));

export class AuthApiError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

/** POST /api/auth/<action>. Throws AuthApiError with a message that is safe to show. */
export async function authApi<T = Record<string, never>>(action: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/auth/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new AuthApiError("Cannot reach the server. Check your connection and try again.", "network");
  }
  const j = await res.json().catch(() => ({ ok: false, error: "Something went wrong. Please try again.", code: "error" }));
  if (!res.ok || !j.ok) throw new AuthApiError(j.error ?? "Something went wrong. Please try again.", j.code ?? "error");
  return j as T;
}

export function saveTokens(t: ApiTokens) {
  const tokens: Tokens = { access: t.accessToken, refresh: t.refreshToken, expiresAt: Date.now() + (t.expiresIn - 30) * 1000 };
  localStorage.setItem(TOKENS, JSON.stringify(tokens));
}

export const passwordLogin = async (email: string, password: string) => saveTokens((await authApi<{ tokens: ApiTokens }>("login", { email, password })).tokens);

// ---- Google (redirect) ----
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const redirectUri = () => `${location.origin}/auth/callback`;

export async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export async function startGoogleLogin() {
  const cfg = await getConfig();
  const { verifier, challenge } = await pkcePair();
  sessionStorage.setItem(VERIFIER, verifier);
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: `${cfg.scopes} aws.cognito.signin.user.admin`,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    identity_provider: "Google",
  });
  location.assign(`${cfg.cognitoDomain}/oauth2/authorize?${q}`);
}

/** Finish the Google redirect: swap the code for tokens. */
export async function completeGoogleLogin(code: string) {
  const cfg = await getConfig();
  const verifier = sessionStorage.getItem(VERIFIER);
  if (!verifier) throw new Error("Sign-in session expired, please try again");
  const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Google sign-in failed. Please try again.");
  sessionStorage.removeItem(VERIFIER);
  saveTokens({ accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in });
}

// ---- session ----
function stored(): Tokens | undefined {
  try { return JSON.parse(localStorage.getItem(TOKENS) ?? "") as Tokens; } catch { return undefined; }
}

export const isSignedIn = () => !!stored() || !!localStorage.getItem(DEV_USER);

export async function getAccessToken(): Promise<string | undefined> {
  const t = stored();
  if (!t) return undefined;
  if (t.expiresAt > Date.now()) return t.access;
  if (!t.refresh) return undefined;
  try {
    const r = await authApi<{ tokens: ApiTokens }>("refresh", { refreshToken: t.refresh });
    saveTokens(r.tokens);
    return r.tokens.accessToken;
  } catch {
    localStorage.removeItem(TOKENS);
    return undefined;
  }
}

export function devUser() { return localStorage.getItem(DEV_USER) ?? undefined; }
export function setDevUser(u: string) { localStorage.setItem(DEV_USER, u); }

export function clearSession() { localStorage.removeItem(TOKENS); localStorage.removeItem(DEV_USER); }

export async function logout() {
  const cfg = await getConfig();
  clearSession();
  if (cfg.devAuth || !cfg.googleSignIn) return location.assign("/");
  // Also end Cognito's own browser session so "Continue with Google" asks again.
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: `${location.origin}/` });
  location.assign(`${cfg.cognitoDomain}/logout?${q}`);
}

// ---- where to go after signing in ----
export const rememberReturnTo = (path: string) => sessionStorage.setItem(RETURN_TO, path);
export const takeReturnTo = () => {
  const p = sessionStorage.getItem(RETURN_TO);
  sessionStorage.removeItem(RETURN_TO);
  return p && p.startsWith("/") && !p.startsWith("/login") && !p.startsWith("/auth/") ? p : "/";
};
/** An MCP client (Claude) sent the user here to sign in; remember its request across the Google redirect. */
export const rememberAuthreq = (h: string) => sessionStorage.setItem(AUTHREQ, h);
export const pendingAuthreq = () => sessionStorage.getItem(AUTHREQ) ?? undefined;

/** Hand the finished sign-in back to Claude. Returns the URL to open. */
export async function completeMcpAuthorization(handle: string): Promise<string> {
  const access = await getAccessToken();
  if (!access) { clearSession(); throw new Error("Your session expired. Please sign in again."); }
  const refresh = stored()?.refresh;
  const res = await fetch("/api/oauth/complete", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
    body: JSON.stringify({ handle, refreshToken: refresh }),
  });
  const j = await res.json().catch(() => ({}));
  sessionStorage.removeItem(AUTHREQ);
  if (!res.ok || !j.ok) throw new Error(j.error ?? "Could not connect Claude. Start again from Claude.");
  return j.redirectUrl as string;
}
