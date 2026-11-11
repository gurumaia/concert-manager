export type Config = {
  tableName: string;
  region: string;
  userPoolId: string;
  cognitoClientId: string;
  /** e.g. https://show-manager-dev-123.auth.us-east-1.amazoncognito.com */
  cognitoDomain: string;
  /** Public origin of the whole app (CloudFront), no trailing slash. */
  publicBaseUrl: string;
  googleClientId?: string;
  googleClientSecret?: string;
  kmsKeyId?: string;
  /** setlist.fm API key; without it setlist lookups are unavailable (manual setlists still work). */
  setlistFmApiKey?: string;
  /** Local development only: trust an `x-dev-user` header instead of Cognito. */
  devAuth: boolean;
  /** Cognito has a Google identity provider configured. */
  googleSignIn?: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const req = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  const devAuth = env.DEV_AUTH === "1";
  return {
    tableName: env.TABLE_NAME ?? "show-manager",
    region: env.COGNITO_REGION ?? env.AWS_REGION ?? "us-east-1",
    userPoolId: devAuth ? (env.USER_POOL_ID ?? "dev") : req("USER_POOL_ID"),
    cognitoClientId: devAuth ? (env.COGNITO_CLIENT_ID ?? "dev") : req("COGNITO_CLIENT_ID"),
    cognitoDomain: (devAuth ? (env.COGNITO_DOMAIN ?? "http://localhost") : req("COGNITO_DOMAIN")).replace(/\/$/, ""),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    kmsKeyId: env.KMS_KEY_ID || undefined,
    setlistFmApiKey: env.SETLISTFM_API_KEY || undefined,
    devAuth,
    googleSignIn: env.GOOGLE_SIGNIN === "1",
  };
}
