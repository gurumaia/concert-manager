import { describe, expect, it } from "vitest";
import { buildGoogleAuthUrl, GoogleCalendarGateway } from "../src/infra/google.js";
import { PlainEncryptor } from "../src/infra/crypto.js";
import { buildCalendarEvent, addMinutes } from "../src/domain/calendar.js";
import type { UserProfile } from "../src/domain/schemas.js";

const user: UserProfile = { id: "u", createdAt: "x", calendar: { refreshTokenEnc: "plain:rt", calendarId: "cal" } };
const cfg = { clientId: "cid", clientSecret: "sec" };

function fakeFetch(handlers: Array<(url: string, init: RequestInit) => Response>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected call ${url}`);
    return h(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("Google Calendar gateway", () => {
  it("asks for offline access with a forced consent so a refresh token is returned", () => {
    const u = new URL(buildGoogleAuthUrl(cfg, "st", "https://x/cb"));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("redirect_uri")).toBe("https://x/cb");
    expect(u.searchParams.get("scope")).toContain("calendar.events");
  });

  it("refreshes the access token once and reuses it", async () => {
    const { f, calls } = fakeFetch([
      () => json({ access_token: "at", expires_in: 3600 }),
      () => json({ id: "e1" }),
      () => json({ id: "e2" }),
    ]);
    const g = new GoogleCalendarGateway(cfg, new PlainEncryptor(), f);
    const body = buildCalendarEvent({ id: "1", title: "T", date: "2026-11-11", createdAt: "", updatedAt: "" }, { eventId: "1", status: "going", sharedWith: [], createdAt: "", updatedAt: "" }, undefined, "u");
    expect(await g.upsertEvent(user, "cal", undefined, body)).toBe("e1");
    expect(await g.upsertEvent(user, "cal", undefined, body)).toBe("e2");
    expect(calls.filter((c) => c.url.includes("oauth2.googleapis.com"))).toHaveLength(1);
    expect(calls[1]?.url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal/events");
  });

  it("recreates an entry the user deleted by hand, and tolerates already-deleted on remove", async () => {
    const { f, calls } = fakeFetch([
      () => json({ access_token: "at", expires_in: 3600 }),
      () => json({ error: { message: "Not Found" } }, 404), // PUT existing
      () => json({ id: "new" }), // POST
      () => json({ error: { message: "Gone" } }, 410), // DELETE
    ]);
    const g = new GoogleCalendarGateway(cfg, new PlainEncryptor(), f);
    const body = buildCalendarEvent({ id: "1", title: "T", date: "2026-11-11", createdAt: "", updatedAt: "" }, { eventId: "1", status: "going", sharedWith: [], createdAt: "", updatedAt: "" }, undefined, "u");
    expect(await g.upsertEvent(user, "cal", "old", body)).toBe("new");
    await g.deleteEvent(user, "cal", "x");
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST", "DELETE"]);
  });

  it("explains a revoked grant", async () => {
    const { f } = fakeFetch([() => json({ error: "invalid_grant" }, 400)]);
    const g = new GoogleCalendarGateway(cfg, new PlainEncryptor(), f);
    await expect(g.listCalendars(user)).rejects.toThrow(/revoked; reconnect/);
  });
});

describe("calendar helpers", () => {
  it("rolls past midnight without time zone math", () => {
    expect(addMinutes("2026-12-31", "23:30", 90)).toEqual({ date: "2027-01-01", time: "01:00" });
  });
  it("starts at doors when there is no show time, and honours an explicit end time", () => {
    const e = { id: "1", title: "T", date: "2026-11-11", doorsTime: "19:00", endTime: "23:00", createdAt: "", updatedAt: "" };
    const b = buildCalendarEvent(e, { eventId: "1", status: "going", sharedWith: [], createdAt: "", updatedAt: "" }, { id: "v", name: "V", timezone: "America/Bahia", createdAt: "", updatedAt: "" }, "u");
    expect(b.start).toEqual({ dateTime: "2026-11-11T19:00:00", timeZone: "America/Bahia" });
    expect(b.end).toEqual({ dateTime: "2026-11-11T23:00:00", timeZone: "America/Bahia" });
  });
});
