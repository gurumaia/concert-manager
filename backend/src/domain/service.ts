import { randomUUID } from "node:crypto";
import {
  DEFAULT_TZ,
  buildCalendarEvent,
  eventEndMinutes,
  eventStartMinutes,
  syncsToCalendar,
  type CalendarGateway,
} from "./calendar.js";
import type { Repo } from "./repo.js";
import type {
  EventInput,
  Rsvp,
  RsvpInput,
  ShowEvent,
  UserProfile,
  Venue,
  VenueInput,
} from "./schemas.js";
import type { Encryptor } from "../infra/crypto.js";

export class AppError extends Error {
  constructor(public code: "not_found" | "invalid" | "conflict" | "unauthorized" | "calendar", message: string) {
    super(message);
  }
}

/** userId is the verified, lower-cased email: Google and password sign-ins of one person are one account. */
export type Ctx = { userId: string; email?: string; name?: string; baseUrl?: string };
export type EventWithVenueInput = EventInput & { venue?: VenueInput };
/** Update payload: omitted = unchanged, null = clear. */
export type Patch<T> = { [K in keyof T]?: T[K] | null };
export type SyncResult = { status: "synced" | "removed" | "skipped" | "error"; message?: string };
export type EventView = ShowEvent & { venue: Venue | null; rsvp: Rsvp | null };

export type ServiceDeps = {
  repo: Repo;
  calendar: CalendarGateway;
  encryptor: Encryptor;
  appUrl?: string;
  buildGoogleAuthUrl?: (state: string, baseUrl: string) => string;
  now?: () => Date;
};

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export class Service {
  private repo: Repo;
  private cal: CalendarGateway;
  constructor(private d: ServiceDeps) {
    this.repo = d.repo;
    this.cal = d.calendar;
  }
  private now = () => (this.d.now ? this.d.now() : new Date()).toISOString();

  // ------------------------------------------------------------------ users
  /** Create the profile on first sight and keep the email current. */
  async ensureUser(ctx: Ctx): Promise<UserProfile> {
    let u = await this.repo.getUser(ctx.userId);
    const email = ctx.email?.toLowerCase();
    if (!u) {
      u = { id: ctx.userId, email, name: ctx.name, createdAt: this.now() };
      await this.repo.putUser(u);
    } else if ((email && u.email !== email) || (ctx.name && u.name !== ctx.name)) {
      u = { ...u, email: email ?? u.email, name: ctx.name ?? u.name };
      await this.repo.putUser(u);
    }
    return u;
  }

  async whoAmI(ctx: Ctx) {
    const u = await this.ensureUser(ctx);
    return { id: u.id, email: u.email, name: u.name, calendarConnected: !!u.calendar };
  }

  // ----------------------------------------------------------------- venues
  async createVenue(ctx: Ctx, input: VenueInput): Promise<Venue> {
    const existing = await this.findVenueByName(ctx, input.name, input.city);
    if (existing) throw new AppError("conflict", `Venue "${existing.name}" already exists (id ${existing.id}). Use update_venue.`);
    const now = this.now();
    const v: Venue = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.repo.putVenue(ctx.userId, v);
    return v;
  }

  async updateVenue(ctx: Ctx, id: string, patch: Patch<VenueInput>): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    if (patch.name === null) throw new AppError("invalid", "A venue needs a name");
    const next = { ...applyPatch(v, patch), id, updatedAt: this.now() } as Venue;
    await this.repo.putVenue(ctx.userId, next);
    await this.resyncEventsOfVenue(ctx, id);
    return next;
  }

  async getVenue(ctx: Ctx, id: string) { return this.mustVenue(ctx, id); }

  async listVenues(ctx: Ctx, opts: { text?: string } = {}) {
    const [venues, events] = await Promise.all([this.repo.listVenues(ctx.userId), this.repo.listEvents(ctx.userId)]);
    const counts = new Map<string, number>();
    for (const e of events) if (e.venueId) counts.set(e.venueId, (counts.get(e.venueId) ?? 0) + 1);
    const q = opts.text ? norm(opts.text) : undefined;
    return venues
      .filter((v) => !q || norm([v.name, v.city, v.address].filter(Boolean).join(" ")).includes(q))
      .map((v) => ({ ...v, eventCount: counts.get(v.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteVenue(ctx: Ctx, id: string) {
    await this.mustVenue(ctx, id);
    const used = (await this.repo.listEvents(ctx.userId)).filter((e) => e.venueId === id);
    if (used.length) throw new AppError("conflict", `Venue is used by ${used.length} event(s). Use merge_venues to move them first.`);
    await this.repo.deleteVenue(ctx.userId, id);
    return { deleted: id };
  }

  /** Move all events of `fromId` to `intoId` and delete `fromId`. */
  async mergeVenues(ctx: Ctx, fromId: string, intoId: string) {
    if (fromId === intoId) throw new AppError("invalid", "fromId and intoId are the same venue");
    await this.mustVenue(ctx, fromId);
    await this.mustVenue(ctx, intoId);
    const events = (await this.repo.listEvents(ctx.userId)).filter((e) => e.venueId === fromId);
    for (const e of events) await this.repo.putEvent(ctx.userId, { ...e, venueId: intoId, updatedAt: this.now() });
    await this.repo.deleteVenue(ctx.userId, fromId);
    await this.resyncEventsOfVenue(ctx, intoId);
    return { moved: events.length, into: intoId };
  }

  private async findVenueByName(ctx: Ctx, name: string, city?: string) {
    const n = norm(name);
    const matches = (await this.repo.listVenues(ctx.userId)).filter((v) => norm(v.name) === n);
    if (matches.length <= 1) return matches[0];
    return matches.find((v) => city && v.city && norm(v.city) === norm(city)) ?? matches[0];
  }

  private async mustVenue(ctx: Ctx, id: string) {
    const v = await this.repo.getVenue(ctx.userId, id);
    if (!v) throw new AppError("not_found", `Venue ${id} not found`);
    return v;
  }

  private async resolveVenueId(ctx: Ctx, input: { venueId?: string; venue?: VenueInput }): Promise<string | undefined> {
    if (input.venueId) {
      await this.mustVenue(ctx, input.venueId);
      return input.venueId;
    }
    if (input.venue) {
      const found = await this.findVenueByName(ctx, input.venue.name, input.venue.city);
      if (found) return found.id;
      return (await this.createVenue(ctx, input.venue)).id;
    }
    return undefined;
  }

  // ----------------------------------------------------------------- events
  async createEvent(ctx: Ctx, input: EventWithVenueInput): Promise<{ event: EventView; created: boolean; duplicateOf?: string }> {
    const { venue: _venue, ...rest } = input;
    const venueId = await this.resolveVenueId(ctx, input);
    const dup = await this.findDuplicate(ctx, rest.title, rest.date, venueId);
    if (dup) return { event: await this.view(ctx, dup), created: false, duplicateOf: dup.id };
    const now = this.now();
    const e: ShowEvent = { ...stripUndefined(rest), venueId, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.repo.putEvent(ctx.userId, e);
    return { event: await this.view(ctx, e), created: true };
  }

  /** Add many events; events matching an existing date + title (+ venue) are skipped, not duplicated. */
  async bulkCreateEvents(ctx: Ctx, inputs: EventWithVenueInput[]) {
    const created: EventView[] = [];
    const skipped: Array<{ title: string; date: string; duplicateOf: string }> = [];
    const failed: Array<{ title: string; date: string; error: string }> = [];
    for (const i of inputs) {
      try {
        const r = await this.createEvent(ctx, i);
        if (r.created) created.push(r.event);
        else skipped.push({ title: i.title, date: i.date, duplicateOf: r.duplicateOf! });
      } catch (err) {
        failed.push({ title: i.title, date: i.date, error: (err as Error).message });
      }
    }
    return { created, skipped, failed };
  }

  private async findDuplicate(ctx: Ctx, title: string, date: string, venueId?: string, ignoreId?: string) {
    const t = norm(title);
    return (await this.repo.listEvents(ctx.userId)).find(
      (e) => e.id !== ignoreId && e.date === date && norm(e.title) === t && (!venueId || !e.venueId || e.venueId === venueId),
    );
  }

  async updateEvent(ctx: Ctx, id: string, patch: Patch<EventWithVenueInput>) {
    const e = await this.mustEvent(ctx, id);
    if (patch.title === null || patch.date === null) throw new AppError("invalid", "title and date cannot be cleared");
    const { venue, venueId: wantedVenueId, ...rest } = patch;
    let venueId = e.venueId;
    if (wantedVenueId === null) venueId = undefined;
    else if (wantedVenueId || venue) venueId = await this.resolveVenueId(ctx, { venueId: wantedVenueId, venue: venue ?? undefined });
    const next = { ...applyPatch(e, rest), venueId, id, updatedAt: this.now() } as ShowEvent;
    await this.repo.putEvent(ctx.userId, next);
    const sync = await this.syncRsvp(ctx, id);
    return { event: await this.view(ctx, next), calendar: sync };
  }

  async getEvent(ctx: Ctx, id: string) { return this.view(ctx, await this.mustEvent(ctx, id)); }

  async deleteEvent(ctx: Ctx, id: string) {
    await this.mustEvent(ctx, id);
    const rsvp = await this.repo.getRsvp(ctx.userId, id);
    let calendar: SyncResult = { status: "skipped" };
    if (rsvp?.calendarEventId) calendar = await this.removeFromCalendar(ctx, rsvp);
    await this.repo.deleteRsvp(ctx.userId, id);
    await this.repo.deleteEvent(ctx.userId, id);
    return { deleted: id, calendar };
  }

  async listEvents(
    ctx: Ctx,
    f: {
      from?: string; to?: string; upcoming?: boolean; venueId?: string; city?: string; text?: string;
      saleStatus?: string; rsvp?: "none" | "interested" | "going" | "skipped" | "attended" | "any";
      limit?: number; offset?: number; sort?: "asc" | "desc";
    } = {},
  ) {
    const [events, rsvps, venues] = await Promise.all([
      this.repo.listEvents(ctx.userId), this.repo.listRsvps(ctx.userId), this.repo.listVenues(ctx.userId),
    ]);
    const rMap = new Map(rsvps.map((r) => [r.eventId, r]));
    const vMap = new Map(venues.map((v) => [v.id, v]));
    const today = this.now().slice(0, 10);
    const q = f.text ? norm(f.text) : undefined;
    let out = events.map<EventView>((e) => ({ ...e, venue: (e.venueId && vMap.get(e.venueId)) || null, rsvp: rMap.get(e.id) ?? null }));
    out = out.filter((e) => {
      if (f.from && e.date < f.from) return false;
      if (f.to && e.date > f.to) return false;
      if (f.upcoming && e.date < today) return false;
      if (f.venueId && e.venueId !== f.venueId) return false;
      if (f.city && norm(e.venue?.city ?? "") !== norm(f.city)) return false;
      if (f.saleStatus && e.saleStatus !== f.saleStatus) return false;
      if (f.rsvp === "none" && e.rsvp) return false;
      if (f.rsvp && f.rsvp !== "none" && f.rsvp !== "any" && e.rsvp?.status !== f.rsvp) return false;
      if (q) {
        const hay = norm([e.title, e.genre, e.venue?.name, e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" "));
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out.sort((a, b) => (a.date + (a.startTime ?? a.doorsTime ?? "")).localeCompare(b.date + (b.startTime ?? b.doorsTime ?? "")));
    if (f.sort === "desc") out.reverse();
    const total = out.length;
    const offset = f.offset ?? 0;
    const limit = f.limit ?? 100;
    return { total, offset, limit, events: out.slice(offset, offset + limit) };
  }

  private async mustEvent(ctx: Ctx, id: string) {
    const e = await this.repo.getEvent(ctx.userId, id);
    if (!e) throw new AppError("not_found", `Event ${id} not found`);
    return e;
  }

  private async view(ctx: Ctx, e: ShowEvent): Promise<EventView> {
    const [venue, rsvp] = await Promise.all([
      e.venueId ? this.repo.getVenue(ctx.userId, e.venueId) : undefined,
      this.repo.getRsvp(ctx.userId, e.id),
    ]);
    return { ...e, venue: venue ?? null, rsvp: rsvp ?? null };
  }

  // ------------------------------------------------------------------- RSVP
  /** Create or update the RSVP for an event (one per event). */
  async setRsvp(ctx: Ctx, eventId: string, input: RsvpInput) {
    const event = await this.mustEvent(ctx, eventId);
    const prev = await this.repo.getRsvp(ctx.userId, eventId);
    const now = this.now();
    const rsvp: Rsvp = {
      ...(prev ?? { sharedWith: [], createdAt: now }),
      ...stripUndefined(input),
      eventId,
      updatedAt: now,
    };
    if (rsvp.tierName && event.tiers?.length && !event.tiers.some((t) => t.name === rsvp.tierName)) {
      throw new AppError("invalid", `Tier "${rsvp.tierName}" not on this event. Tiers: ${event.tiers.map((t) => t.name).join(", ")}`);
    }
    const warnings = rsvp.status === "going" ? await this.conflicts(ctx, event) : [];
    await this.repo.putRsvp(ctx.userId, rsvp);
    const calendar = await this.syncRsvp(ctx, eventId);
    return { rsvp: (await this.repo.getRsvp(ctx.userId, eventId))!, warnings, calendar };
  }

  async removeRsvp(ctx: Ctx, eventId: string) {
    await this.mustEvent(ctx, eventId);
    const r = await this.repo.getRsvp(ctx.userId, eventId);
    if (!r) throw new AppError("not_found", "No RSVP on this event");
    const calendar = r.calendarEventId ? await this.removeFromCalendar(ctx, r) : ({ status: "skipped" } as SyncResult);
    await this.repo.deleteRsvp(ctx.userId, eventId);
    return { removed: eventId, calendar };
  }

  async listRsvps(ctx: Ctx, status?: RsvpInput["status"]) {
    const { events } = await this.listEvents(ctx, { rsvp: status ?? "any", limit: 1000 });
    return events.filter((e) => e.rsvp);
  }

  /** Other "going" shows that overlap this one. Warn only; never blocks. */
  private async conflicts(ctx: Ctx, event: ShowEvent): Promise<string[]> {
    const others = (await this.repo.listRsvps(ctx.userId)).filter((r) => r.status === "going" && r.eventId !== event.id);
    const out: string[] = [];
    const s1 = eventStartMinutes(event), e1 = eventEndMinutes(event);
    for (const r of others) {
      const o = await this.repo.getEvent(ctx.userId, r.eventId);
      if (!o || o.date !== event.date) continue;
      const s2 = eventStartMinutes(o), e2 = eventEndMinutes(o);
      const overlaps = s1 === undefined || s2 === undefined || e1 === undefined || e2 === undefined || (s1 < e2 && s2 < e1);
      if (overlaps) out.push(`Conflicts with "${o.title}" on ${o.date}${o.startTime ? ` at ${o.startTime}` : ""} (you are going).`);
    }
    return out;
  }

  async shareRsvp(ctx: Ctx, eventId: string, emails: string[]) {
    await this.ensureUser(ctx); // so the recipient can see who shared
    const r = await this.repo.getRsvp(ctx.userId, eventId);
    if (!r) throw new AppError("not_found", "RSVP first, then share it");
    const me = ctx.email?.toLowerCase();
    const add = emails.map((e) => e.trim().toLowerCase()).filter((e) => e && e !== me);
    const next = { ...r, sharedWith: [...new Set([...r.sharedWith, ...add])], updatedAt: this.now() };
    await this.repo.putRsvp(ctx.userId, next);
    return { eventId, sharedWith: next.sharedWith };
  }

  async unshareRsvp(ctx: Ctx, eventId: string, emails: string[]) {
    const r = await this.repo.getRsvp(ctx.userId, eventId);
    if (!r) throw new AppError("not_found", "No RSVP on this event");
    const drop = new Set(emails.map((e) => e.trim().toLowerCase()));
    const next = { ...r, sharedWith: r.sharedWith.filter((e) => !drop.has(e)), updatedAt: this.now() };
    await this.repo.putRsvp(ctx.userId, next);
    return { eventId, sharedWith: next.sharedWith };
  }

  /** RSVPs other people shared with me (read-only). */
  async listSharedWithMe(ctx: Ctx) {
    const email = (await this.ensureUser(ctx)).email;
    if (!email) return [];
    const refs = await this.repo.listSharedWith(email);
    const out: Array<EventView & { sharedBy: { id: string; name?: string; email?: string } }> = [];
    for (const { ownerId, eventId } of refs) {
      const e = await this.repo.getEvent(ownerId, eventId);
      if (!e) continue;
      const owner = await this.repo.getUser(ownerId);
      const view = await this.view({ userId: ownerId }, e);
      out.push({ ...view, sharedBy: { id: ownerId, name: owner?.name, email: owner?.email } });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ------------------------------------------------------------------ stats
  async stats(ctx: Ctx, opts: { year?: number } = {}) {
    const { events } = await this.listEvents(ctx, { limit: 100000 });
    const attended = events.filter((e) => e.rsvp?.status === "attended" && (!opts.year || e.date.startsWith(String(opts.year))));
    const byVenue = new Map<string, { venueId: string | null; venue: string; city?: string; count: number }>();
    const byYear: Record<string, number> = {};
    const spent: Record<string, number> = {};
    for (const e of attended) {
      const key = e.venueId ?? "none";
      const row = byVenue.get(key) ?? { venueId: e.venueId ?? null, venue: e.venue?.name ?? "(no venue)", city: e.venue?.city, count: 0 };
      row.count++;
      byVenue.set(key, row);
      byYear[e.date.slice(0, 4)] = (byYear[e.date.slice(0, 4)] ?? 0) + 1;
      const cur = e.currency ?? "BRL";
      spent[cur] = (spent[cur] ?? 0) + (e.rsvp?.pricePaid ?? 0) + (e.rsvp?.feesPaid ?? 0);
    }
    const today = this.now().slice(0, 10);
    return {
      attendedTotal: attended.length,
      attendedByVenue: [...byVenue.values()].sort((a, b) => b.count - a.count),
      attendedByYear: byYear,
      totalSpent: spent,
      upcomingGoing: events.filter((e) => e.rsvp?.status === "going" && e.date >= today).length,
      undecidedUpcoming: events.filter((e) => !e.rsvp && e.date >= today).length,
    };
  }

  // --------------------------------------------------------------- calendar
  async calendarStatus(ctx: Ctx) {
    const u = await this.ensureUser(ctx);
    return {
      connected: !!u.calendar,
      connectedAs: u.calendar?.connectedAs,
      calendarId: u.calendar?.calendarId,
      calendarName: u.calendar?.calendarName,
      needsCalendarSelection: !!u.calendar && !u.calendar.calendarId,
    };
  }

  async calendarConnectUrl(ctx: Ctx) {
    if (!this.d.buildGoogleAuthUrl) throw new AppError("calendar", "Google Calendar is not configured on this server");
    await this.ensureUser(ctx);
    const state = randomUUID() + randomUUID().replace(/-/g, "");
    await this.repo.putOAuthState(state, { userId: ctx.userId, expiresAt: Date.now() + 10 * 60_000 });
    return { url: this.d.buildGoogleAuthUrl(state, ctx.baseUrl ?? this.d.appUrl ?? ""), note: "Open this link in a browser, approve access, then call calendar_list and calendar_select." };
  }

  /** Called by the OAuth callback once Google returned a refresh token. */
  async completeCalendarConnect(state: string, refreshToken: string, googleEmail?: string) {
    const st = await this.repo.takeOAuthState(state);
    if (!st || st.expiresAt < Date.now()) throw new AppError("invalid", "This connect link expired. Start again.");
    const u = await this.repo.getUser(st.userId);
    if (!u) throw new AppError("not_found", "User not found");
    const enc = await this.d.encryptor.encrypt(refreshToken);
    await this.repo.putUser({ ...u, calendar: { ...u.calendar, connectedAs: googleEmail, refreshTokenEnc: enc } });
    return { userId: st.userId };
  }

  private async mustCalendarUser(ctx: Ctx) {
    const u = await this.ensureUser(ctx);
    if (!u.calendar) throw new AppError("calendar", "Google Calendar is not connected. Call calendar_connect first.");
    return u;
  }

  async calendarList(ctx: Ctx) {
    const u = await this.mustCalendarUser(ctx);
    return { calendars: await this.cal.listCalendars(u), selected: u.calendar?.calendarId };
  }

  /** Pick an existing calendar by id, or create a new one by name. Re-syncs every going/attended RSVP. */
  async calendarSelect(ctx: Ctx, opts: { calendarId?: string; createName?: string }) {
    const u = await this.mustCalendarUser(ctx);
    let target: { id: string; name: string };
    if (opts.createName) target = await this.cal.createCalendar(u, opts.createName, DEFAULT_TZ);
    else if (opts.calendarId) {
      const found = (await this.cal.listCalendars(u)).find((c) => c.id === opts.calendarId);
      if (!found) throw new AppError("not_found", "Calendar not found or not writable");
      target = found;
    } else throw new AppError("invalid", "Pass calendarId or createName");
    const previous = u.calendar!.calendarId;
    const updated: UserProfile = { ...u, calendar: { ...u.calendar!, calendarId: target.id, calendarName: target.name } };
    await this.repo.putUser(updated);
    // Move existing entries off the old calendar.
    if (previous && previous !== target.id) {
      for (const r of await this.repo.listRsvps(ctx.userId)) {
        if (r.calendarEventId) {
          await this.removeFromCalendar(ctx, r, u).catch(() => undefined);
        }
      }
    }
    const resync = await this.resyncAll(ctx);
    return { calendarId: target.id, calendarName: target.name, resync };
  }

  async calendarDisconnect(ctx: Ctx, opts: { removeEvents?: boolean } = {}) {
    const u = await this.mustCalendarUser(ctx);
    let removed = 0;
    for (const r of await this.repo.listRsvps(ctx.userId)) {
      if (!r.calendarEventId) continue;
      if (opts.removeEvents) {
        await this.removeFromCalendar(ctx, r, u).catch(() => undefined);
        removed++;
      } else {
        await this.repo.putRsvp(ctx.userId, { ...r, calendarEventId: undefined, calendarId: undefined });
      }
    }
    await this.repo.putUser({ ...u, calendar: undefined });
    return { disconnected: true, removedEvents: removed };
  }

  /** Re-push every going/attended RSVP to the calendar (e.g. after changing the calendar). */
  async resyncAll(ctx: Ctx) {
    const rsvps = await this.repo.listRsvps(ctx.userId);
    const results = { synced: 0, removed: 0, skipped: 0, errors: [] as string[] };
    for (const r of rsvps) {
      const s = await this.syncRsvp(ctx, r.eventId);
      if (s.status === "synced") results.synced++;
      else if (s.status === "removed") results.removed++;
      else if (s.status === "error") results.errors.push(`${r.eventId}: ${s.message}`);
      else results.skipped++;
    }
    return results;
  }

  private async resyncEventsOfVenue(ctx: Ctx, venueId: string) {
    for (const e of await this.repo.listEvents(ctx.userId)) {
      if (e.venueId === venueId) await this.syncRsvp(ctx, e.id);
    }
  }

  private async removeFromCalendar(ctx: Ctx, r: Rsvp, user?: UserProfile): Promise<SyncResult> {
    const u = user ?? (await this.repo.getUser(ctx.userId));
    if (!u?.calendar || !r.calendarEventId) return { status: "skipped" };
    try {
      await this.cal.deleteEvent(u, r.calendarId ?? u.calendar.calendarId!, r.calendarEventId);
      const exists = await this.repo.getRsvp(ctx.userId, r.eventId);
      if (exists) await this.repo.putRsvp(ctx.userId, { ...exists, calendarEventId: undefined, calendarId: undefined });
      return { status: "removed" };
    } catch (e) {
      return { status: "error", message: (e as Error).message };
    }
  }

  /** Make the calendar match the RSVP. Never throws: the RSVP is saved even if Google is down. */
  async syncRsvp(ctx: Ctx, eventId: string): Promise<SyncResult> {
    try {
      const [u, event, rsvp] = await Promise.all([
        this.repo.getUser(ctx.userId), this.repo.getEvent(ctx.userId, eventId), this.repo.getRsvp(ctx.userId, eventId),
      ]);
      if (!rsvp || !event) return { status: "skipped" };
      if (!u?.calendar?.calendarId) {
        return { status: "skipped", message: u?.calendar ? "No calendar selected yet" : "Calendar not connected" };
      }
      if (!syncsToCalendar(rsvp.status)) {
        return rsvp.calendarEventId ? await this.removeFromCalendar(ctx, rsvp, u) : { status: "skipped" };
      }
      const venue = event.venueId ? await this.repo.getVenue(ctx.userId, event.venueId) : undefined;
      const body = buildCalendarEvent(event, rsvp, venue, ctx.userId, ctx.baseUrl ?? this.d.appUrl);
      const calendarId = u.calendar.calendarId;
      // Calendar changed since the last push: the old entry was removed by calendarSelect.
      const existing = rsvp.calendarId === calendarId ? rsvp.calendarEventId : undefined;
      const id = await this.cal.upsertEvent(u, calendarId, existing, body);
      await this.repo.putRsvp(ctx.userId, { ...rsvp, calendarId, calendarEventId: id });
      return { status: "synced" };
    } catch (e) {
      return { status: "error", message: (e as Error).message };
    }
  }
}

/** Apply a patch: undefined keeps the value, null removes it. */
function applyPatch<T extends object>(base: T, patch: object): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
