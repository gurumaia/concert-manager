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
import type { SetlistGateway } from "./setlist.js";
import type {
  EventInput,
  Setlist,
  SetlistInput,
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
export type SetlistActResult = { act: string; status: "found" | "not_found" | "kept_manual" | "error"; songs?: number; message?: string };
export type EventView = ShowEvent & { venue: Venue | null; rsvp: Rsvp | null };
type MatchedBy = "venue_and_date" | "title_and_date" | "title_and_date_venue_changed";
type VenueNote = { given: string; matched: string; id: string; how: "similar" };
type VenueResolution = { id?: string; pending?: VenueInput; note?: VenueNote };
export type UpsertResult = {
  event: EventView;
  created: boolean;
  /** An existing event matched and was changed. */
  updated: boolean;
  changedFields: string[];
  duplicateOf?: string;
  matchedBy?: MatchedBy;
  /** The show moved: it matched on title and date at a different venue, so its venue was changed. */
  venueChanged?: { from: { id: string; name: string } | null; to: { id: string; name: string } };
  /** The venue name given was matched to an existing venue with a different (similar) name. */
  venueNote?: VenueNote;
  venueCreated?: { id: string; name: string };
  calendar?: SyncResult;
};

export type ServiceDeps = {
  repo: Repo;
  calendar: CalendarGateway;
  encryptor: Encryptor;
  appUrl?: string;
  /** setlist.fm lookup; absent when no API key is configured. */
  setlists?: SetlistGateway;
  buildGoogleAuthUrl?: (state: string, baseUrl: string) => string;
  now?: () => Date;
};

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// Words that do not identify a venue ("Fabrique" and "Fabrique Club" are the same place; "Casa Natura" and "Casa Rock" are not).
const GENERIC_VENUE_WORDS = new Set([
  "club", "clube", "hall", "casa", "teatro", "theatre", "theater", "arena", "espaco", "espacio", "bar", "pub", "house", "live",
  "music", "musical", "sala", "estadio", "ginasio", "centro", "de", "do", "da", "dos", "das", "the", "of", "e", "and", "&",
]);
const coreTokens = (s: string) =>
  norm(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && !GENERIC_VENUE_WORDS.has(t));

/** Stands in for the id of a venue that is about to be created. */
const NEW_VENUE = "\u0000new-venue";

export class Service {
  private repo: Repo;
  private cal: CalendarGateway;
  constructor(private d: ServiceDeps) {
    this.repo = d.repo;
    this.cal = d.calendar;
  }
  /** The service clock (injectable in tests). */
  clock = () => (this.d.now ? this.d.now() : new Date());
  private now = () => this.clock().toISOString();

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
    if (existing) {
      throw new AppError("conflict", existing.retiredAt
        ? `Venue "${existing.name}" exists but is retired (id ${existing.id}). Use unretire_venue if it reopened.`
        : `Venue "${existing.name}" already exists (id ${existing.id}). Use update_venue.`);
    }
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

  /** Retired venues are hidden unless includeRetired is set. */
  async listVenues(ctx: Ctx, opts: { text?: string; includeRetired?: boolean } = {}) {
    const [venues, events] = await Promise.all([this.repo.listVenues(ctx.userId), this.repo.listEvents(ctx.userId)]);
    const counts = new Map<string, number>();
    for (const e of events) if (e.venueId) counts.set(e.venueId, (counts.get(e.venueId) ?? 0) + 1);
    const q = opts.text ? norm(opts.text) : undefined;
    return venues
      .filter((v) => opts.includeRetired || !v.retiredAt)
      .filter((v) => !q || norm([v.name, v.city, v.address].filter(Boolean).join(" ")).includes(q))
      .map((v) => ({ ...v, eventCount: counts.get(v.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Mark a venue as closed. Its events, RSVPs and stats are untouched. */
  async retireVenue(ctx: Ctx, id: string): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    if (v.retiredAt) return v;
    const next = { ...v, retiredAt: this.now(), updatedAt: this.now() };
    await this.repo.putVenue(ctx.userId, next);
    return next;
  }

  /** Bring a retired venue back (it reopened, or was retired by mistake). */
  async unretireVenue(ctx: Ctx, id: string): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    if (!v.retiredAt) return v;
    const { retiredAt: _r, ...rest } = v;
    const next = { ...rest, updatedAt: this.now() };
    await this.repo.putVenue(ctx.userId, next);
    return next;
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
    const target = await this.mustVenue(ctx, intoId);
    if (target.retiredAt) throw new AppError("invalid", `Venue "${target.name}" is retired; unretire it before merging into it.`);
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

  /** Closest existing venue for a name: exact (ignoring case/accents) first, then a unique "same core name" match. */
  private async matchVenue(ctx: Ctx, name: string, city?: string): Promise<{ venue: Venue; how: "exact" | "similar" } | undefined> {
    const venues = await this.repo.listVenues(ctx.userId);
    const n = norm(name);
    const exact = venues.filter((v) => norm(v.name) === n);
    if (exact.length) {
      return { venue: exact.find((v) => city && v.city && norm(v.city) === norm(city)) ?? exact[0]!, how: "exact" };
    }
    const core = coreTokens(name);
    if (!core.length) return undefined;
    const similar = venues.filter((v) => {
      if (city && v.city && norm(v.city) !== norm(city)) return false; // different city: a different venue
      const other = coreTokens(v.name);
      if (!other.length) return false;
      const [small, big] = core.length <= other.length ? [core, other] : [other, core];
      return small.every((t) => big.includes(t));
    });
    if (similar.length > 1) {
      throw new AppError(
        "conflict",
        `Venue "${name}" could be ${[...similar].sort((x, y) => x.name.localeCompare(y.name)).map((v) => `"${v.name}" (id ${v.id})`).join(" or ")}. Pass venueId to choose.`,
      );
    }
    return similar[0] ? { venue: similar[0], how: "similar" } : undefined;
  }

  /**
   * Work out which venue an event input refers to WITHOUT creating anything yet: a venueId is used as is, a name is matched
   * against existing venues, and only an unmatched name is left `pending` (created later, once we know it is needed).
   */
  private async resolveVenue(ctx: Ctx, input: { venueId?: string; venue?: VenueInput }): Promise<VenueResolution> {
    if (input.venueId) {
      await this.mustVenue(ctx, input.venueId);
      return { id: input.venueId };
    }
    if (input.venue) {
      const m = await this.matchVenue(ctx, input.venue.name, input.venue.city);
      if (m) return { id: m.venue.id, note: m.how === "similar" ? { given: input.venue.name, matched: m.venue.name, id: m.venue.id, how: "similar" } : undefined };
      return { pending: input.venue };
    }
    return {};
  }

  private async materializeVenue(ctx: Ctx, r: VenueResolution): Promise<{ id?: string; created?: Venue }> {
    if (r.id || !r.pending) return { id: r.id };
    const created = await this.createVenue(ctx, r.pending);
    return { id: created.id, created };
  }

  // ----------------------------------------------------------------- events
  /**
   * Add an event, or update the existing one when this is a duplicate. Duplicate means: same date at the same venue, or same
   * date and title where either venue is unknown. On a duplicate (mode "update", the default) the fields you pass overwrite the
   * stored ones and the rest are left alone; mode "skip" changes nothing.
   */
  async createEvent(ctx: Ctx, input: EventWithVenueInput, mode: "update" | "skip" = "update", protect: Set<string> = new Set()): Promise<UpsertResult> {
    const { venue: _venue, venueId: _vid, ...rest } = input;
    const res = await this.resolveVenue(ctx, input);
    // A venue name that matched nothing is a venue we know is new: it must not look "unknown" and match another venue's show.
    const found = await this.findDuplicate(ctx, rest.title, rest.date, res.id ?? (res.pending ? NEW_VENUE : undefined), rest.lineup, protect);

    if (found) {
      // Skip mode never changes anything, including the venue of a show that moved.
      if (mode === "skip") {
        return { event: await this.view(ctx, found.event), created: false, updated: false, changedFields: [], duplicateOf: found.event.id, matchedBy: found.by, venueNote: res.note };
      }
      const moved = found.by === "title_and_date_venue_changed";
      const patch = await this.upsertPatch(ctx, found.event, rest, res, moved);
      const venueNote = res.note;
      if (!Object.keys(patch).length) {
        return { event: await this.view(ctx, found.event), created: false, updated: false, changedFields: [], duplicateOf: found.event.id, matchedBy: found.by, venueNote };
      }
      protect.add(found.event.id);
      const oldVenue = found.event.venueId ? await this.repo.getVenue(ctx.userId, found.event.venueId) : undefined;
      const r = await this.updateEvent(ctx, found.event.id, patch);
      const venueChanged = "venueId" in patch && r.event.venue && r.event.venueId !== found.event.venueId
        ? { from: oldVenue ? { id: oldVenue.id, name: oldVenue.name } : null, to: { id: r.event.venue.id, name: r.event.venue.name } }
        : undefined;
      return { event: r.event, created: false, updated: true, changedFields: Object.keys(patch), duplicateOf: found.event.id, matchedBy: found.by, venueNote, venueChanged, calendar: r.calendar };
    }

    const { id: venueId, created: venueCreated } = await this.materializeVenue(ctx, res);
    const now = this.now();
    const e: ShowEvent = { ...stripUndefined(rest), venueId, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.repo.putEvent(ctx.userId, e);
    protect.add(e.id);
    return {
      event: await this.view(ctx, e), created: true, updated: false, changedFields: [],
      venueNote: res.note, venueCreated: venueCreated ? { id: venueCreated.id, name: venueCreated.name } : undefined,
    };
  }

  /** Fields of `incoming` that differ from the stored event. Omitted fields never clear anything. */
  private async upsertPatch(ctx: Ctx, existing: ShowEvent, incoming: Omit<EventInput, "venueId">, res: VenueResolution, moved: boolean): Promise<Patch<EventWithVenueInput>> {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stripUndefined(incoming))) {
      if (k === "id" || k === "createdAt" || k === "updatedAt") continue; // bookkeeping, never taken from a re-sent show
      if (k === "title") {
        if (norm(String(v)) !== norm(existing.title)) patch.title = v;
        continue;
      }
      if (JSON.stringify((existing as Record<string, unknown>)[k]) !== JSON.stringify(v)) patch[k] = v;
    }
    const venueId = res.id ?? (res.pending && (!existing.venueId || moved) ? (await this.materializeVenue(ctx, res)).id : undefined);
    if (venueId && venueId !== existing.venueId) patch.venueId = venueId;
    return patch as Patch<EventWithVenueInput>;
  }

  /**
   * Add many events (up to 100). Duplicates are updated in place (see createEvent) rather than rejected; the result lists what
   * was created, updated, left unchanged or failed, and which venues were created or matched by a similar name.
   */
  async bulkCreateEvents(ctx: Ctx, inputs: EventWithVenueInput[], mode: "update" | "skip" = "update") {
    const created: EventView[] = [];
    const updated: Array<{ event: EventView; changedFields: string[]; matchedBy?: string; venueChanged?: UpsertResult["venueChanged"] }> = [];
    const unchanged: Array<{ title: string; date: string; duplicateOf: string; matchedBy?: string }> = [];
    const failed: Array<{ title: string; date: string; error: string }> = [];
    const venuesCreated: Array<{ id: string; name: string }> = [];
    const venuesMatchedBySimilarName: Array<{ given: string; matched: string; id: string }> = [];
    // Shows touched earlier in this batch are never moved by a later entry: "Festival" at two venues on one day is two shows.
    const protect = new Set<string>();
    for (const i of inputs) {
      try {
        const r = await this.createEvent(ctx, i, mode, protect);
        if (r.created) created.push(r.event);
        else if (r.updated) updated.push({ event: r.event, changedFields: r.changedFields, matchedBy: r.matchedBy, venueChanged: r.venueChanged });
        else unchanged.push({ title: i.title, date: i.date, duplicateOf: r.duplicateOf!, matchedBy: r.matchedBy });
        if (r.venueCreated && !venuesCreated.some((v) => v.id === r.venueCreated!.id)) venuesCreated.push(r.venueCreated);
        const n = r.venueNote;
        if (n && !venuesMatchedBySimilarName.some((x) => x.id === n.id && x.given === n.given)) venuesMatchedBySimilarName.push({ given: n.given, matched: n.matched, id: n.id });
      } catch (err) {
        failed.push({ title: i.title, date: i.date, error: (err as Error).message });
      }
    }
    return { created, updated, unchanged, failed, venuesCreated, venuesMatchedBySimilarName };
  }

  /**
   * The existing show this input refers to, if any:
   *  1. same date at the same venue;
   *  2. same date and title, when either venue is unknown;
   *  3. a show that MOVED: same date and exact title at a different venue. Only when it is unambiguous (one candidate), still in
   *     the future, not already touched by this batch, and the lineups do not contradict each other.
   */
  private async findDuplicate(ctx: Ctx, title: string, date: string, venueId?: string, lineup?: EventInput["lineup"], protect: Set<string> = new Set(), ignoreId?: string): Promise<{ event: ShowEvent; by: MatchedBy } | undefined> {
    const sameDay = (await this.repo.listEvents(ctx.userId)).filter((e) => e.id !== ignoreId && e.date === date);
    if (venueId) {
      const byVenue = sameDay.find((e) => e.venueId === venueId);
      if (byVenue) return { event: byVenue, by: "venue_and_date" };
    }
    const t = norm(title);
    const byTitle = sameDay.find((e) => norm(e.title) === t && (!venueId || !e.venueId || e.venueId === venueId));
    if (byTitle) return { event: byTitle, by: "title_and_date" };

    if (date < this.now().slice(0, 10)) return undefined; // past shows do not move
    const names = (l?: EventInput["lineup"]) => new Set((l ?? []).map((a) => norm(a.name)));
    const mine = names(lineup);
    const moved = sameDay.filter((e) => {
      if (protect.has(e.id) || norm(e.title) !== t || !e.venueId) return false;
      const theirs = names(e.lineup);
      return !mine.size || !theirs.size || [...mine].some((n) => theirs.has(n));
    });
    return moved.length === 1 ? { event: moved[0]!, by: "title_and_date_venue_changed" } : undefined;
  }

  async updateEvent(ctx: Ctx, id: string, patch: Patch<EventWithVenueInput>) {
    const e = await this.mustEvent(ctx, id);
    if (patch.title === null || patch.date === null) throw new AppError("invalid", "title and date cannot be cleared");
    const { venue, venueId: wantedVenueId, ...rest } = patch;
    let venueId = e.venueId;
    if (wantedVenueId === null) venueId = undefined;
    else if (wantedVenueId || venue) {
      venueId = (await this.materializeVenue(ctx, await this.resolveVenue(ctx, { venueId: wantedVenueId, venue: venue ?? undefined }))).id;
    }
    // createdAt is the NEW badge: re-sending or editing a show never resets it.
    const next = { ...applyPatch(e, rest), venueId, id, createdAt: e.createdAt, updatedAt: this.now() } as ShowEvent;
    await this.repo.putEvent(ctx.userId, next);
    const sync = await this.syncRsvp(ctx, id);
    return { event: await this.view(ctx, next), calendar: sync };
  }

  async getEvent(ctx: Ctx, id: string) { return this.view(ctx, await this.mustEvent(ctx, id)); }

  // --------------------------------------------------------------- setlists
  /** Today's date where the show happens. */
  private todayAt(venue?: Venue) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: venue?.timezone ?? DEFAULT_TZ }).format(this.clock());
  }

  /** Save (or, with no songs, remove) the setlist one act played. Manual setlists are never replaced by lookups. */
  async setSetlist(ctx: Ctx, eventId: string, input: SetlistInput) {
    const e = await this.mustEvent(ctx, eventId);
    const key = norm(input.act);
    const others = (e.setlists ?? []).filter((x) => norm(x.act) !== key);
    const next: Setlist[] = input.songs.length
      ? [...others, { act: input.act, songs: input.songs, url: input.url, source: "manual", fetchedAt: this.now() }]
      : others;
    await this.repo.putEvent(ctx.userId, stripUndefined({ ...e, setlists: next.length ? next : undefined, updatedAt: this.now() }) as ShowEvent);
    return this.view(ctx, (await this.repo.getEvent(ctx.userId, eventId))!);
  }

  /**
   * Look up what each act of a past show played on setlist.fm and store it. Acts with a manual setlist are kept unless `force`.
   * A lookup that finds nothing leaves what is stored alone, so it is safe to run again later (setlists are often posted days after).
   */
  async syncSetlists(ctx: Ctx, eventId: string, opts: { force?: boolean } = {}) {
    if (!this.d.setlists) throw new AppError("invalid", "Setlist lookup is not set up on this server (no setlist.fm API key). You can still add a setlist by hand.");
    const e = await this.mustEvent(ctx, eventId);
    const venue = e.venueId ? await this.repo.getVenue(ctx.userId, e.venueId) : undefined;
    if (e.date > this.todayAt(venue)) throw new AppError("invalid", "This show has not happened yet, so it has no setlist.");
    const acts = e.lineup?.length ? e.lineup.map((a) => a.name) : [e.title];
    let setlists = [...(e.setlists ?? [])];
    const results: SetlistActResult[] = [];
    for (const act of acts) {
      const key = norm(act);
      const have = setlists.find((x) => norm(x.act) === key);
      if (have?.source === "manual" && !opts.force) { results.push({ act, status: "kept_manual", songs: have.songs.length }); continue; }
      try {
        const found = await this.d.setlists.find({ artist: act, date: e.date, city: venue?.city });
        if (!found) { results.push({ act, status: "not_found" }); continue; }
        setlists = [...setlists.filter((x) => norm(x.act) !== key), { act, songs: found.songs, url: found.url, source: "setlist.fm", fetchedAt: this.now() }];
        results.push({ act, status: "found", songs: found.songs.length });
      } catch (err) {
        results.push({ act, status: "error", message: (err as Error).message });
      }
    }
    if (results.some((r) => r.status === "found")) {
      // Keep the lineup order, then any manual extras.
      const order = (x: Setlist) => { const i = acts.findIndex((a) => norm(a) === norm(x.act)); return i < 0 ? acts.length : i; };
      setlists.sort((a, b) => order(a) - order(b));
      await this.repo.putEvent(ctx.userId, { ...e, setlists, updatedAt: this.now() });
    }
    return { event: await this.view(ctx, (await this.repo.getEvent(ctx.userId, eventId))!), results };
  }

  /**
   * Scheduled sweep for every account: shows from the last `days` days that the user went to (or planned to) and that still lack a
   * setlist for some act. Setlists are usually posted within a day or two, so a daily run over a short window catches them.
   */
  async syncRecentSetlists(days = 14) {
    const summary = { users: 0, checked: 0, found: 0, errors: 0 };
    if (!this.d.setlists) return summary;
    const cutoff = new Date(this.clock().getTime() - days * 86400000).toISOString().slice(0, 10);
    for (const u of await this.repo.listUsers()) {
      summary.users++;
      const ctx: Ctx = { userId: u.id, email: u.email, name: u.name };
      const rsvps = new Map((await this.repo.listRsvps(u.id)).map((r) => [r.eventId, r]));
      for (const e of await this.repo.listEvents(u.id)) {
        const status = rsvps.get(e.id)?.status;
        if ((status !== "going" && status !== "attended") || e.date < cutoff) continue;
        const acts = e.lineup?.length ? e.lineup.map((a) => a.name) : [e.title];
        if (acts.every((a) => e.setlists?.some((x) => norm(x.act) === norm(a)))) continue;
        try {
          const r = await this.syncSetlists(ctx, e.id);
          summary.checked++;
          summary.found += r.results.filter((x) => x.status === "found").length;
          summary.errors += r.results.filter((x) => x.status === "error").length;
        } catch { /* show not past yet in its own time zone, or deleted meanwhile */ }
      }
    }
    return summary;
  }

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
