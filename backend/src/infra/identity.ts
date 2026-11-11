import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  GetUserCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export type Tokens = { accessToken: string; refreshToken?: string; expiresIn: number };
export type UserInfo = { email?: string; emailVerified: boolean; name?: string };

/** Sign-in with email + password, owned by this app (Cognito is only the user store). */
export interface IdentityApi {
  login(email: string, password: string): Promise<Tokens>;
  signUp(email: string, password: string, name?: string): Promise<void>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendCode(email: string): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(email: string, code: string, password: string): Promise<void>;
  refresh(refreshToken: string): Promise<Tokens>;
  getUser(accessToken: string): Promise<UserInfo>;
}

/** Errors safe to show the user; `code` is stable for the UI. */
export class IdentityError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const MESSAGES: Record<string, [string, string, number]> = {
  NotAuthorizedException: ["bad_credentials", "Incorrect email or password.", 401],
  UserNotFoundException: ["bad_credentials", "Incorrect email or password.", 401],
  UserNotConfirmedException: ["unconfirmed", "Please confirm your email first. We can send you a new code.", 403],
  UsernameExistsException: ["exists", "An account with this email already exists. Try signing in.", 409],
  InvalidPasswordException: ["weak_password", "Password is too weak: use at least 10 characters with upper and lower case letters and a number.", 400],
  InvalidParameterException: ["invalid", "Please check the details and try again.", 400],
  CodeMismatchException: ["bad_code", "That code is not right. Check it and try again.", 400],
  ExpiredCodeException: ["expired_code", "That code has expired. Ask for a new one.", 400],
  LimitExceededException: ["rate_limited", "Too many attempts. Please wait a few minutes and try again.", 429],
  TooManyRequestsException: ["rate_limited", "Too many attempts. Please wait a few minutes and try again.", 429],
  TooManyFailedAttemptsException: ["rate_limited", "Too many attempts. Please wait a few minutes and try again.", 429],
};

function translate(e: unknown): never {
  const name = (e as { name?: string }).name ?? "";
  const hit = MESSAGES[name];
  if (name === "InvalidPasswordException" || name === "InvalidParameterException") {
    // Cognito's text for these is user-readable (password policy, bad email), so keep it.
    const raw = (e as Error).message;
    throw new IdentityError(hit![0], raw && raw.length < 200 ? raw : hit![1], hit![2]);
  }
  if (hit) throw new IdentityError(hit[0], hit[1], hit[2]);
  console.error("cognito error", name, (e as Error).message);
  throw new IdentityError("error", "Something went wrong. Please try again.", 500);
}

export class CognitoIdentity implements IdentityApi {
  private c: CognitoIdentityProviderClient;
  constructor(private clientId: string, region: string, client?: CognitoIdentityProviderClient) {
    this.c = client ?? new CognitoIdentityProviderClient({ region });
  }

  async login(email: string, password: string): Promise<Tokens> {
    try {
      const r = await this.c.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH", ClientId: this.clientId, AuthParameters: { USERNAME: email, PASSWORD: password },
      }));
      const a = r.AuthenticationResult;
      if (!a?.AccessToken) throw new IdentityError("challenge", "This account needs extra steps that are not supported yet.", 400);
      return { accessToken: a.AccessToken, refreshToken: a.RefreshToken, expiresIn: a.ExpiresIn ?? 3600 };
    } catch (e) {
      if (e instanceof IdentityError) throw e;
      return translate(e);
    }
  }

  async signUp(email: string, password: string, name?: string) {
    try {
      await this.c.send(new SignUpCommand({
        ClientId: this.clientId, Username: email, Password: password,
        UserAttributes: [{ Name: "email", Value: email }, ...(name ? [{ Name: "name", Value: name }] : [])],
      }));
    } catch (e) { translate(e); }
  }

  async confirmSignUp(email: string, code: string) {
    try { await this.c.send(new ConfirmSignUpCommand({ ClientId: this.clientId, Username: email, ConfirmationCode: code })); } catch (e) { translate(e); }
  }

  async resendCode(email: string) {
    try { await this.c.send(new ResendConfirmationCodeCommand({ ClientId: this.clientId, Username: email })); } catch (e) { translate(e); }
  }

  async forgotPassword(email: string) {
    try { await this.c.send(new ForgotPasswordCommand({ ClientId: this.clientId, Username: email })); }
    catch (e) {
      // Do not reveal whether the account exists.
      const n = (e as { name?: string }).name;
      if (n === "UserNotFoundException" || n === "InvalidParameterException") return;
      translate(e);
    }
  }

  async confirmForgotPassword(email: string, code: string, password: string) {
    try {
      await this.c.send(new ConfirmForgotPasswordCommand({ ClientId: this.clientId, Username: email, ConfirmationCode: code, Password: password }));
    } catch (e) { translate(e); }
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    try {
      const r = await this.c.send(new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: this.clientId, AuthParameters: { REFRESH_TOKEN: refreshToken },
      }));
      const a = r.AuthenticationResult;
      if (!a?.AccessToken) throw new IdentityError("bad_refresh", "Session expired. Please sign in again.", 401);
      return { accessToken: a.AccessToken, refreshToken: a.RefreshToken ?? refreshToken, expiresIn: a.ExpiresIn ?? 3600 };
    } catch (e) {
      if (e instanceof IdentityError) throw e;
      const n = (e as { name?: string }).name;
      if (n === "NotAuthorizedException") throw new IdentityError("bad_refresh", "Session expired. Please sign in again.", 401);
      return translate(e);
    }
  }

  async getUser(accessToken: string): Promise<UserInfo> {
    const r = await this.c.send(new GetUserCommand({ AccessToken: accessToken }));
    const attr = (n: string) => r.UserAttributes?.find((a) => a.Name === n)?.Value;
    return { email: attr("email")?.toLowerCase(), emailVerified: attr("email_verified") === "true", name: attr("name") };
  }
}
