import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Ctx } from "../domain/service.js";
import type { Config } from "./config.js";
import type { IdentityApi } from "./identity.js";

export type Authenticator = (bearer: string, headers: Headers) => Promise<Ctx>;

export class AuthError extends Error {}

/** Validates a Cognito access token and resolves the user's email/name via the hosted-UI userinfo endpoint. */
export function cognitoAuthenticator(cfg: Config, idp: IdentityApi, fetchFn: typeof fetch = fetch): Authenticator {
  const issuer = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const profiles = new Map<string, { email?: string; name?: string; exp: number }>();

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer });
      if (payload.token_use !== "access") throw new AuthError("Use an access token");
      if (payload.client_id !== cfg.cognitoClientId) throw new AuthError("Token was issued to another client");
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError("Invalid or expired token");
    }
    let p = profiles.get(token);
    if (!p || p.exp < Date.now()) {
      let info: { email?: string; emailVerified: boolean; name?: string };
      try {
        info = await idp.getUser(token);
      } catch {
        // Tokens from the Google redirect flow may lack the user-admin scope; the userinfo endpoint covers those.
        const res = await fetchFn(`${cfg.cognitoDomain}/oauth2/userInfo`, { headers: { authorization: `Bearer ${token}` } });
        const j = res.ok ? ((await res.json()) as { email?: string; email_verified?: boolean | string; name?: string }) : {};
        info = { email: j.email?.toLowerCase(), emailVerified: j.email_verified === true || j.email_verified === "true", name: j.name };
      }
      if (!info.email || !info.emailVerified) throw new AuthError("A verified email is required");
      p = { email: info.email, name: info.name, exp: Date.now() + 3600_000 };
      profiles.set(token, p);
      if (profiles.size > 200) profiles.delete(profiles.keys().next().value!);
    }
    // The verified email is the account id, so password and Google sign-ins of one person share their data.
    return { userId: p.email!, email: p.email, name: p.name };
  };
}

/** Local development: `x-dev-user: alice` (optionally `x-dev-email`). */
export const devAuthenticator: Authenticator = async (_t, headers) => {
  const id = headers.get("x-dev-user");
  if (!id) throw new AuthError("Send x-dev-user");
  return { userId: id, email: headers.get("x-dev-email") ?? `${id}@example.com`, name: id };
};
