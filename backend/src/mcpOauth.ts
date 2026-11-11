import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// OAuth authorization server for MCP clients (claude.ai). The login page is ours; Cognito only stores users and issues tokens.
export const CLIENT_TTL_MS = 180 * 24 * 3600_000;
export const AUTHREQ_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 5 * 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type Registration = { redirectUris: string[]; clientName?: string };
export type AuthRequest = { clientId: string; redirectUri: string; state?: string; codeChallenge: string };
export type CodeGrant = AuthRequest & { userId: string; tokensEnc: string };

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** https, or http on loopback (RFC 8252). */
export function isValidRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string" || !uri || uri.length > 2000) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password || !u.hostname) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** Exact match, or port-agnostic match for registered loopback URIs. */
export function redirectUriMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try { r = new URL(requested); } catch { return false; }
  if (r.protocol !== "http:" || !LOOPBACK.has(r.hostname)) return false;
  return registered.some((x) => {
    try {
      const g = new URL(x);
      return g.protocol === "http:" && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
    } catch { return false; }
  });
}

/** PKCE S256 */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
