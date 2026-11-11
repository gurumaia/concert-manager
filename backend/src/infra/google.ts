import type { CalendarEventBody, CalendarGateway, CalendarListItem } from "../domain/calendar.js";
import type { UserProfile } from "../domain/schemas.js";
import type { Encryptor } from "./crypto.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
  "openid",
  "email",
];

export type GoogleConfig = { clientId: string; clientSecret: string };

export function buildGoogleAuthUrl(cfg: GoogleConfig, state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeGoogleCode(cfg: GoogleConfig, code: string, redirectUri: string): Promise<{ refreshToken: string; email?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const j = (await res.json()) as { refresh_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.refresh_token) throw new Error(`Google token exchange failed: ${j.error_description ?? j.error ?? res.status}`);
  let email: string | undefined;
  if (j.id_token) {
    try {
      email = (JSON.parse(Buffer.from(j.id_token.split(".")[1]!, "base64url").toString()) as { email?: string }).email;
    } catch { /* ignore */ }
  }
  return { refreshToken: j.refresh_token, email };
}

/** Google Calendar REST client. Access tokens are cached per refresh token for their lifetime. */
export class GoogleCalendarGateway implements CalendarGateway {
  private cache = new Map<string, { token: string; exp: number }>();
  constructor(private cfg: GoogleConfig, private enc: Encryptor, private fetchFn: typeof fetch = fetch) {}

  private async accessToken(user: UserProfile): Promise<string> {
    if (!user.calendar) throw new Error("Google Calendar is not connected");
    const hit = this.cache.get(user.calendar.refreshTokenEnc);
    if (hit && hit.exp > Date.now() + 30_000) return hit.token;
    const refresh = await this.enc.decrypt(user.calendar.refreshTokenEnc);
    const res = await this.fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) {
      throw new Error(j.error === "invalid_grant" ? "Google access was revoked; reconnect the calendar" : `Google token refresh failed: ${j.error ?? res.status}`);
    }
    this.cache.set(user.calendar.refreshTokenEnc, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  }

  private async call(user: UserProfile, method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.accessToken(user);
    const res = await this.fetchFn(`https://www.googleapis.com/calendar/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined;
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const err = new Error(`Google Calendar ${method} ${path} failed: ${j?.error?.message ?? res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return j;
  }

  async listCalendars(user: UserProfile): Promise<CalendarListItem[]> {
    const j = await this.call(user, "GET", "/users/me/calendarList?minAccessRole=writer&maxResults=250");
    return (j.items ?? []).map((c: any) => ({ id: c.id, name: c.summaryOverride ?? c.summary, primary: !!c.primary, accessRole: c.accessRole }));
  }

  async createCalendar(user: UserProfile, name: string, timeZone: string): Promise<CalendarListItem> {
    const j = await this.call(user, "POST", "/calendars", { summary: name, timeZone });
    return { id: j.id, name: j.summary };
  }

  async upsertEvent(user: UserProfile, calendarId: string, existing: string | undefined, body: CalendarEventBody): Promise<string> {
    const cal = encodeURIComponent(calendarId);
    if (existing) {
      try {
        const j = await this.call(user, "PUT", `/calendars/${cal}/events/${encodeURIComponent(existing)}`, body);
        return j.id;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status !== 404 && status !== 410) throw e; // deleted by hand: recreate below
      }
    }
    const j = await this.call(user, "POST", `/calendars/${cal}/events`, body);
    return j.id;
  }

  async deleteEvent(user: UserProfile, calendarId: string, eventId: string): Promise<void> {
    try {
      await this.call(user, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 404 && status !== 410) throw e; // already gone
    }
  }
}
