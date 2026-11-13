import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_TZ,
  buildCalendarEvent,
  eventEndMinutes,
  eventStartMinutes,
  syncsToCalendar,
  type CalendarGateway,
} from "./calendar.js";
import {
  MAX_INLINE_BYTES, MAX_PHOTOS_PER_EVENT, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, PHOTO_TYPES, sniffImage,
  type ImageFetcher, type Photo, type PhotoStore, type PhotoType, type PhotoView,
} from "./photos.js";
import type { Repo } from "./repo.js";
import { personKey, type ReviewData, type ReviewLink, type ReviewRecipe, type ReviewShow } from "./review.js";
import { Email } from "./schemas.js";
import type { RecentSetlist, SetlistGateway } from "./setlist.js";
import type {
  EventInput,
  Person,
  Playlist,
  PlaylistInput,
  Setlist,
  SetlistInput,
  Rsvp,
  RsvpInput,
  ShowEvent,
  UserProfile,
  Venue,
  VenueInput,
  VenueName,
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
export type RecentActResult = { act: string; status: "found" | "none" | "error"; setlists: RecentSetlist[]; message?: string };
export type SetlistActResult = { act: string; status: "found" | "not_found" | "kept_manual" | "error"; songs?: number; message?: string };
/**
 * `past`: the show's date is over where it happens. `attended`: you were going and it is past, so you went. There is no stored
 * "attended" any more; a past show you did not go to has to be marked skipped.
 */
export type EventView = ShowEvent & { venue: Venue | null; rsvp: Rsvp | null; past: boolean; attended: boolean; /** Photos you can see on this show (yours, or the ones shared with you). */ photoCount: number;
  /** The best score of the show's acts (or the overall score when no act has one); what lists show. Only for shows you attended. */ topScore?: number };
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
  /** Object storage for photos; without it photo operations answer "not configured". */
  photos?: PhotoStore;
  /** Downloads images for add_photo_from_url (must refuse private addresses). */
  fetchImage?: ImageFetcher;
  buildGoogleAuthUrl?: (state: string, baseUrl: string) => string;
  now?: () => Date;
};

/** The best act score, falling back to the overall score (shows with one act, or scored before acts could be). */
export const topScoreOf = (r: Rsvp | null): number | undefined => {
  if (!r) return undefined;
  const acts = Object.values(r.actScores ?? {});
  return acts.length ? Math.max(...acts) : r.score;
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

/** A venue's names oldest first (undated = oldest); equal dates keep their stored order. */
/** Every name a venue has had, for text search (undefined venue = nothing). */
export const venueText = (v?: Venue | null): string[] => (v ? venueNames(v).map((n) => n.name) : []);
export const venueNames = (v: Venue): VenueName[] =>
  (v.names?.length ? v.names : [{ name: v.name }])
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.from ?? "").localeCompare(b.n.from ?? "") || a.i - b.i)
    .map((x) => x.n);
/** The name in effect on `date`; before the first dated name, the oldest one. */
export const nameAt = (v: Venue, date: string): string => {
  const all = venueNames(v);
  let cur = all[0]!;
  for (const n of all) if (!n.from || n.from <= date) cur = n;
  return cur.name;
};
const sameName = (v: Venue, n: string) => venueNames(v).some((x) => norm(x.name) === norm(n));

/** Stands in for the id of a venue that is about to be created. */
const NEW_VENUE = "\u0000new-venue";

const REVIEW_PHOTOS_PER_SHOW = 12;
const REVIEW_MAX_PHOTOS = 200;

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
    let next = { ...applyPatch(v, patch), id, updatedAt: this.now() } as Venue;
    // Changing `name` here corrects the name in effect today (a typo, say). A real rename needs its date: use renameVenue.
    if (patch.name && v.names?.length && norm(patch.name) !== norm(this.currentName(v))) {
      const cur = this.currentEntry(v);
      next = { ...next, names: v.names.map((n) => (n === cur ? { ...n, name: patch.name! } : n)) };
    }
    next = this.syncCurrent(next);
    await this.assertNameFree(ctx, next, id);
    await this.repo.putVenue(ctx.userId, next);
    await this.resyncEventsOfVenue(ctx, id);
    return this.present(next);
  }

  async getVenue(ctx: Ctx, id: string) { return this.present(await this.mustVenue(ctx, id)); }

  private currentEntry(v: Venue): VenueName {
    const today = this.todayAt(v);
    const all = venueNames(v);
    let cur = all[0]!;
    for (const n of all) if (!n.from || n.from <= today) cur = n;
    return v.names?.find((n) => n.name === cur.name && n.from === cur.from) ?? cur;
  }
  private currentName = (v: Venue) => nameAt(v, this.todayAt(v));
  /** Keep the stored `name` equal to the name in effect today. */
  private syncCurrent(v: Venue): Venue { return { ...v, name: this.currentName(v) }; }
  /** What callers see: the current name, plus the full history. */
  private present(v: Venue): Venue & { names: VenueName[] } { return { ...v, name: this.currentName(v), names: venueNames(v) }; }

  /** No two venues may share a name (past or present) in the same city. */
  private async assertNameFree(ctx: Ctx, v: Venue, selfId?: string) {
    const others = (await this.repo.listVenues(ctx.userId)).filter((o) => o.id !== selfId);
    for (const n of venueNames(v)) {
      const clash = others.find((o) => sameName(o, n.name) && (!v.city || !o.city || norm(v.city) === norm(o.city)));
      if (clash) throw new AppError("conflict", `"${n.name}" is already a name of venue "${clash.name}" (id ${clash.id}). Use merge_venues if they are the same place.`);
    }
  }

  /**
   * Record that a venue was renamed. `effectiveFrom` is the day the new name started applying (not the day we found out): shows
   * on or after it display the new name, earlier shows keep the old one. Same date as an existing entry replaces its name.
   */
  async renameVenue(ctx: Ctx, id: string, name: string, effectiveFrom: string): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    const trimmed = name.trim();
    if (!trimmed) throw new AppError("invalid", "A venue needs a name");
    const names = venueNames(v).filter((n) => n.from !== effectiveFrom);
    const next = this.syncCurrent({ ...v, names: [...names, { name: trimmed, from: effectiveFrom }], updatedAt: this.now() });
    next.names = venueNames(next);
    await this.assertNameFree(ctx, next, id);
    await this.repo.putVenue(ctx.userId, next);
    await this.resyncEventsOfVenue(ctx, id);
    return this.present(next);
  }

  /** Drop a name from a venue's history (it was recorded by mistake). The venue always keeps at least one name. */
  async removeVenueName(ctx: Ctx, id: string, name: string): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    const kept = venueNames(v).filter((n) => norm(n.name) !== norm(name));
    if (kept.length === venueNames(v).length) throw new AppError("not_found", `Venue has no name "${name}"`);
    if (!kept.length) throw new AppError("invalid", "A venue needs at least one name");
    // If the oldest name goes, the next one now covers all earlier dates: drop its start date so no show is left without a name.
    if (kept[0]!.from) kept[0] = { name: kept[0]!.name };
    const next = this.syncCurrent({ ...v, names: kept, updatedAt: this.now() });
    await this.repo.putVenue(ctx.userId, next);
    await this.resyncEventsOfVenue(ctx, id);
    return this.present(next);
  }

  /** Retired venues are hidden unless includeRetired is set. */
  async listVenues(ctx: Ctx, opts: { text?: string; includeRetired?: boolean } = {}) {
    const [venues, events] = await Promise.all([this.repo.listVenues(ctx.userId), this.repo.listEvents(ctx.userId)]);
    const counts = new Map<string, number>();
    for (const e of events) if (e.venueId) counts.set(e.venueId, (counts.get(e.venueId) ?? 0) + 1);
    const q = opts.text ? norm(opts.text) : undefined;
    return venues
      .filter((v) => opts.includeRetired || !v.retiredAt)
      .filter((v) => !q || norm([...venueNames(v).map((n) => n.name), v.city, v.address].filter(Boolean).join(" ")).includes(q))
      .map((v) => ({ ...this.present(v), eventCount: counts.get(v.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Mark a venue as closed. Its events, RSVPs and stats are untouched. */
  async retireVenue(ctx: Ctx, id: string): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    if (v.retiredAt) return this.present(v);
    const next = { ...v, retiredAt: this.now(), updatedAt: this.now() };
    await this.repo.putVenue(ctx.userId, next);
    return this.present(next);
  }

  /** Bring a retired venue back (it reopened, or was retired by mistake). */
  async unretireVenue(ctx: Ctx, id: string): Promise<Venue> {
    const v = await this.mustVenue(ctx, id);
    if (!v.retiredAt) return this.present(v);
    const { retiredAt: _r, ...rest } = v;
    const next = { ...rest, updatedAt: this.now() };
    await this.repo.putVenue(ctx.userId, next);
    return this.present(next);
  }

  async deleteVenue(ctx: Ctx, id: string) {
    await this.mustVenue(ctx, id);
    const used = (await this.repo.listEvents(ctx.userId)).filter((e) => e.venueId === id);
    if (used.length) throw new AppError("conflict", `Venue is used by ${used.length} event(s). Use merge_venues to move them first.`);
    await this.repo.deleteVenue(ctx.userId, id);
    return { deleted: id };
  }

  /** Move all events of `fromId` to `intoId` and delete `fromId`. */
  async mergeVenues(ctx: Ctx, fromId: string, intoId: string, nameChangedOn?: string) {
    if (fromId === intoId) throw new AppError("invalid", "fromId and intoId are the same venue");
    const source = await this.mustVenue(ctx, fromId);
    const target = await this.mustVenue(ctx, intoId);
    if (target.retiredAt) throw new AppError("invalid", `Venue "${target.name}" is retired; unretire it before merging into it.`);
    const events = (await this.repo.listEvents(ctx.userId)).filter((e) => e.venueId === fromId);
    // Keep the names of the venue going away. With `nameChangedOn`, the surviving venue's own name started that day, so the
    // old names cover the time before it; without it the old names stay searchable but shows display the surviving name.
    const mine = venueNames(target);
    if (nameChangedOn) {
      if (mine[0]!.from) throw new AppError("invalid", `"${mine[0]!.name}" already has a start date (${mine[0]!.from}); use rename_venue to change it.`);
      mine[0] = { ...mine[0]!, from: nameChangedOn };
    }
    const old = venueNames(source).filter((n) => !mine.some((m) => norm(m.name) === norm(n.name)));
    const merged = this.syncCurrent({ ...target, names: venueNames({ ...target, names: [...old, ...mine] }), updatedAt: this.now() });
    if (merged.names!.length === 1) delete merged.names;
    for (const e of events) await this.repo.putEvent(ctx.userId, { ...e, venueId: intoId, updatedAt: this.now() });
    await this.repo.putVenue(ctx.userId, merged);
    await this.repo.deleteVenue(ctx.userId, fromId);
    await this.resyncEventsOfVenue(ctx, intoId);
    return { moved: events.length, into: intoId };
  }

  private async findVenueByName(ctx: Ctx, name: string, city?: string) {
    const matches = (await this.repo.listVenues(ctx.userId)).filter((v) => sameName(v, name));
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
    const exact = venues.filter((v) => sameName(v, name));
    if (exact.length) {
      return { venue: exact.find((v) => city && v.city && norm(v.city) === norm(city)) ?? exact[0]!, how: "exact" };
    }
    const core = coreTokens(name);
    if (!core.length) return undefined;
    const similar = venues.filter((v) => {
      if (city && v.city && norm(v.city) !== norm(city)) return false; // different city: a different venue
      return venueNames(v).some((vn) => {
        const other = coreTokens(vn.name);
        if (!other.length) return false;
        const [small, big] = core.length <= other.length ? [core, other] : [other, core];
        return small.every((t) => big.includes(t));
      });
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

  /** The one place that decides "did I go": going (or the legacy stored "attended") on a show whose date is over at its venue. */
  private toView(e: ShowEvent, venue: Venue | null, rsvp: Rsvp | null, today: (v?: Venue) => string, photoCount = 0): EventView {
    const r = rsvp && rsvp.status === "attended" ? { ...rsvp, status: "going" as const } : rsvp;
    const past = e.date < today(venue ?? undefined);
    // The venue shows the name it had on the day of the show; `currentName` and `names` cover the rest of its history.
    return { ...e, venue: venue ? { ...venue, name: nameAt(venue, e.date), currentName: nameAt(venue, today(venue)), names: venueNames(venue) } : null, rsvp: r, past, attended: past && r?.status === "going", photoCount, topScore: topScoreOf(r) };
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
   * What each act of a show has played lately on setlist.fm, newest first, so a client can build a playlist for the show.
   * Nothing is stored: the songs are returned for the client to work with.
   */
  async recentSetlists(ctx: Ctx, eventId: string, opts: { limit?: number } = {}) {
    if (!this.d.setlists) throw new AppError("invalid", "Setlist lookup is not set up on this server (no setlist.fm API key).");
    const e = await this.mustEvent(ctx, eventId);
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const acts: RecentActResult[] = [];
    for (const act of e.lineup?.length ? e.lineup.map((a) => a.name) : [e.title]) {
      try {
        const setlists = await this.d.setlists.recent({ artist: act, limit, before: e.date });
        acts.push({ act, status: setlists.length ? "found" : "none", setlists });
      } catch (err) {
        acts.push({ act, status: "error", setlists: [], message: (err as Error).message });
      }
    }
    return { eventId: e.id, title: e.title, date: e.date, acts, playlists: e.playlists ?? [] };
  }

  /** Save the playlist a client built for one act on one streaming service; url null removes it. One per act and service. */
  async setPlaylist(ctx: Ctx, eventId: string, input: PlaylistInput) {
    const e = await this.mustEvent(ctx, eventId);
    const service = input.service.trim().toLowerCase();
    const key = norm(input.act);
    const others = (e.playlists ?? []).filter((p) => !(p.service === service && norm(p.act) === key));
    const next: Playlist[] = input.url
      ? [...others, { act: input.act, service, url: input.url, ...(input.title ? { title: input.title } : {}), ...(input.trackCount !== undefined ? { trackCount: input.trackCount } : {}), createdAt: this.now() }]
      : others;
    const acts = e.lineup?.length ? e.lineup.map((a) => a.name) : [e.title];
    const order = (p: Playlist) => { const i = acts.findIndex((a) => norm(a) === norm(p.act)); return i < 0 ? acts.length : i; };
    next.sort((a, b) => order(a) - order(b));
    await this.repo.putEvent(ctx.userId, stripUndefined({ ...e, playlists: next.length ? next : undefined, updatedAt: this.now() }) as ShowEvent);
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
    for (const p of await this.repo.listPhotos(ctx.userId, id)) await this.removePhoto(ctx, p);
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
    const [events, rsvps, venues, photos] = await Promise.all([
      this.repo.listEvents(ctx.userId), this.repo.listRsvps(ctx.userId), this.repo.listVenues(ctx.userId), this.repo.listAllPhotos(ctx.userId),
    ]);
    const photoCounts = new Map<string, number>();
    for (const p of photos) photoCounts.set(p.eventId, (photoCounts.get(p.eventId) ?? 0) + 1);
    const rMap = new Map(rsvps.map((r) => [r.eventId, r]));
    const vMap = new Map(venues.map((v) => [v.id, v]));
    const todayByZone = new Map<string, string>();
    const todayIn = (v?: Venue) => {
      const zone = v?.timezone ?? DEFAULT_TZ;
      if (!todayByZone.has(zone)) todayByZone.set(zone, this.todayAt(v));
      return todayByZone.get(zone)!;
    };
    const today = this.now().slice(0, 10);
    const q = f.text ? norm(f.text) : undefined;
    let out = events.map<EventView>((e) => this.toView(e, (e.venueId && vMap.get(e.venueId)) || null, rMap.get(e.id) ?? null, todayIn, photoCounts.get(e.id) ?? 0));
    out = out.filter((e) => {
      if (f.from && e.date < f.from) return false;
      if (f.to && e.date > f.to) return false;
      if (f.upcoming && e.date < today) return false;
      if (f.venueId && e.venueId !== f.venueId) return false;
      if (f.city && norm(e.venue?.city ?? "") !== norm(f.city)) return false;
      if (f.saleStatus && e.saleStatus !== f.saleStatus) return false;
      if (f.rsvp === "none" && e.rsvp) return false;
      // "attended" = going to a show that is over; "going" = going to one that is still ahead.
      if (f.rsvp === "attended" && !e.attended) return false;
      if (f.rsvp === "going" && !(e.rsvp?.status === "going" && !e.past)) return false;
      if (f.rsvp && f.rsvp !== "none" && f.rsvp !== "any" && f.rsvp !== "attended" && f.rsvp !== "going" && e.rsvp?.status !== f.rsvp) return false;
      if (q) {
        const hay = norm([e.title, e.genre, ...venueText(e.venue), e.venue?.city, ...(e.lineup ?? []).map((a) => a.name)].filter(Boolean).join(" "));
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
    const [venue, rsvp, photos] = await Promise.all([
      e.venueId ? this.repo.getVenue(ctx.userId, e.venueId) : undefined,
      this.repo.getRsvp(ctx.userId, e.id),
      this.repo.listPhotos(ctx.userId, e.id),
    ]);
    return this.toView(e, venue ?? null, rsvp ?? null, (v) => this.todayAt(v), photos.length);
  }

  // ------------------------------------------------------------------- RSVP
  /** Create or update the RSVP for an event (one per event). */
  async setRsvp(ctx: Ctx, eventId: string, input: RsvpInput) {
    const event = await this.mustEvent(ctx, eventId);
    // Resolve the people first: linking a new email can update other shows' RSVPs, so `prev` is read after.
    const companions = input.companions ? await this.resolveCompanions(ctx, input.companions) : undefined;
    const prev = await this.repo.getRsvp(ctx.userId, eventId);
    const now = this.now();
    const { score, actScores, ...rest } = input;
    const rsvp: Rsvp = {
      ...(prev ?? { sharedWith: [], createdAt: now }),
      ...stripUndefined(rest),
      ...(companions ? { companions } : {}),
      status: input.status === "attended" ? "going" : input.status, // "attended" is retired: going + a past date means you went
      eventId,
      updatedAt: now,
    };
    await this.applyScores(ctx, event, rsvp, score, actScores);
    if (rsvp.tierName && event.tiers?.length && !event.tiers.some((t) => t.name === rsvp.tierName)) {
      throw new AppError("invalid", `Tier "${rsvp.tierName}" not on this event. Tiers: ${event.tiers.map((t) => t.name).join(", ")}`);
    }
    const warnings = rsvp.status === "going" ? await this.conflicts(ctx, event) : [];
    // People with an email are shared with: added when they join the list, dropped when they leave it.
    const dir = await this.directory(ctx);
    const emailsOf = (names?: string[]) => new Set((names ?? []).map((n) => dir.get(personKey(n))?.email).filter((e): e is string => !!e));
    const was = emailsOf(prev?.companions), now_ = emailsOf(rsvp.companions);
    const drop = [...was].filter((e) => !now_.has(e));
    const me = ctx.email?.toLowerCase();
    const add = [...now_].filter((e) => e !== me);
    if (add.length) await this.ensureUser(ctx); // so the recipient can see who shared
    rsvp.sharedWith = [...new Set([...rsvp.sharedWith.filter((e) => !drop.includes(e)), ...add])];
    await this.repo.putRsvp(ctx.userId, rsvp);
    await this.sharePhotosWith(ctx, eventId, add, drop);
    const calendar = await this.syncRsvp(ctx, eventId);
    return { rsvp: (await this.repo.getRsvp(ctx.userId, eventId))!, warnings, calendar };
  }

  /**
   * Overall and per-act scores. Only a show you attended (going, date over) can carry them; once the RSVP is anything else they are dropped.
   * `acts` merges into the existing ones: an act set to null is cleared, null clears them all.
   */
  private async applyScores(ctx: Ctx, event: ShowEvent, rsvp: Rsvp, score: number | null | undefined, acts: Record<string, number | null> | null | undefined) {
    const valid = (n: number) => n >= 0 && n <= 10 && Number.isInteger(n * 2);
    if (typeof score === "number" && !valid(score)) throw new AppError("invalid", "Score must be between 0 and 10 in steps of 0.5.");
    if (score === null) delete rsvp.score;
    else if (score !== undefined) rsvp.score = score;
    if (acts === null) delete rsvp.actScores;
    else if (acts) {
      const next = { ...(rsvp.actScores ?? {}) };
      for (const [name, v] of Object.entries(acts)) {
        const act = (event.lineup ?? []).find((a) => norm(a.name) === norm(name));
        if (!act) throw new AppError("invalid", `"${name}" is not in this show's lineup.${event.lineup?.length ? ` Lineup: ${event.lineup.map((a) => a.name).join(", ")}` : ""}`);
        if (v === null) delete next[act.name];
        else if (!valid(v)) throw new AppError("invalid", "Scores must be between 0 and 10 in steps of 0.5.");
        else next[act.name] = v;
      }
      if (Object.keys(next).length) rsvp.actScores = next; else delete rsvp.actScores;
    }
    const setting = typeof score === "number" || (!!acts && Object.values(acts).some((v) => typeof v === "number"));
    if (setting) {
      const venue = event.venueId ? await this.repo.getVenue(ctx.userId, event.venueId) : undefined;
      if (rsvp.status !== "going" || event.date >= this.todayAt(venue)) throw new AppError("invalid", "Only a show you attended (going, with a date in the past) can be scored.");
    } else if (rsvp.status !== "going") { delete rsvp.score; delete rsvp.actScores; } // scores from before you changed your mind
  }

  /** Change only the scores of an attended show (no calendar sync, no conflict check): cheap enough to call on every slider move. */
  async setScores(ctx: Ctx, eventId: string, input: { score?: number | null; actScores?: Record<string, number | null> | null }) {
    const event = await this.mustEvent(ctx, eventId);
    const prev = await this.repo.getRsvp(ctx.userId, eventId);
    if (!prev) throw new AppError("not_found", "Mark the show as going first, then score it.");
    const rsvp: Rsvp = { ...prev, status: prev.status === "attended" ? "going" : prev.status, updatedAt: this.now() };
    await this.applyScores(ctx, event, rsvp, input.score, input.actScores);
    await this.repo.putRsvp(ctx.userId, rsvp);
    return { rsvp: (await this.repo.getRsvp(ctx.userId, eventId))! };
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

  // ------------------------------------------------------------------ people
  /** The user's people directory, by person key. */
  private async directory(ctx: Ctx): Promise<Map<string, Person>> {
    return new Map((await this.repo.listPeople(ctx.userId)).map((p) => [p.key, p]));
  }

  /** "Ana", "Ana <ana@x.com>" or "ana@x.com" -> name and optional (lower-cased) email. */
  private parseCompanion(raw: string, dir: Map<string, Person>): { name: string; email?: string } | undefined {
    const s = raw.trim().replace(/\s+/g, " ");
    if (!s) return undefined;
    const shaped = s.match(/^(.*?)\s*<\s*([^<>\s@,]+@[^<>\s@,]+)\s*>$/);
    const bare = /^[^\s@,<>]+@[^\s@,<>]+$/.test(s) ? s : undefined;
    const email = (shaped?.[2] ?? bare)?.toLowerCase();
    if (!email) return { name: s };
    if (!Email.safeParse(email).success) throw new AppError("invalid", `"${email}" is not a valid email address.`);
    const known = [...dir.values()].find((p) => p.email === email); // an email you already linked is that person
    const local = email.split("@")[0]!.replace(/[._-]+/g, " ");
    const name = shaped?.[1]?.trim() || known?.name || local.charAt(0).toUpperCase() + local.slice(1);
    return { name, email };
  }

  /** Turns what the user typed into plain names (de-duplicated), saving any email given to the person's entry. */
  private async resolveCompanions(ctx: Ctx, raw: string[]): Promise<string[]> {
    const dir = await this.directory(ctx);
    const out = new Map<string, string>();
    for (const r of raw) {
      const p = this.parseCompanion(r, dir);
      if (!p) continue;
      const key = personKey(p.name);
      if (!key) continue;
      const known = dir.get(key);
      if (p.email && known?.email !== p.email) {
        const saved = await this.setPersonEmail(ctx, known?.name ?? p.name, p.email);
        dir.set(key, saved.person!);
      }
      if (!out.has(key)) out.set(key, dir.get(key)?.name ?? p.name);
    }
    return [...out.values()];
  }

  async listPeople(ctx: Ctx) {
    return [...(await this.directory(ctx)).values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Link a person from "Going with" to an email (or unlink with null), on every show they are on, past and upcoming:
   * those shows and their photos are shared with the email, so they show up under "Shared with me", now or after they sign up.
   */
  async setPersonEmail(ctx: Ctx, name: string, email: string | null) {
    const key = personKey(name);
    if (!key) throw new AppError("invalid", "Give the person's name.");
    const next = email?.trim().toLowerCase() || undefined;
    if (next && !Email.safeParse(next).success) throw new AppError("invalid", `"${next}" is not a valid email address.`);
    const known = (await this.directory(ctx)).get(key);
    const old = known?.email;
    const person: Person | undefined = next ? { key, name: known?.name ?? name.trim().replace(/\s+/g, " "), email: next } : undefined;
    if (old === next) return { person: person ?? known, shows: 0 };
    if (person) await this.repo.putPerson(ctx.userId, person); else await this.repo.deletePerson(ctx.userId, key);
    if (next) await this.ensureUser(ctx); // so the recipient can see who shared
    const dir = await this.directory(ctx);
    const me = ctx.email?.toLowerCase();
    let shows = 0;
    for (const r of await this.repo.listRsvps(ctx.userId)) {
      const names = r.companions ?? [];
      if (!names.some((n) => personKey(n) === key)) continue;
      const others = new Set(names.filter((n) => personKey(n) !== key).map((n) => dir.get(personKey(n))?.email).filter(Boolean));
      const drop = old && !others.has(old) ? [old] : [];
      const add = next && next !== me ? [next] : [];
      await this.repo.putRsvp(ctx.userId, { ...r, sharedWith: [...new Set([...r.sharedWith.filter((e) => !drop.includes(e)), ...add])], updatedAt: this.now() });
      await this.sharePhotosWith(ctx, r.eventId, add, drop);
      shows++;
    }
    return { person: person ?? undefined, shows };
  }

  /** Adds and removes emails on every photo of a show (no storage access needed). */
  private async sharePhotosWith(ctx: Ctx, eventId: string, add: string[], drop: string[]) {
    if (!add.length && !drop.length) return;
    for (const p of await this.repo.listPhotos(ctx.userId, eventId)) {
      const sharedWith = [...new Set([...p.sharedWith.filter((e) => !drop.includes(e)), ...add])];
      if (sharedWith.length !== p.sharedWith.length || sharedWith.some((e) => !p.sharedWith.includes(e))) await this.repo.putPhoto(ctx.userId, { ...p, sharedWith });
    }
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

  /** Shows other people shared with me (read-only): shared RSVPs, plus shows where only photos were shared (no RSVP details). */
  async listSharedWithMe(ctx: Ctx) {
    const email = (await this.ensureUser(ctx)).email;
    if (!email) return [];
    const rsvpRefs = await this.repo.listSharedWith(email);
    const photoRefs = await this.repo.listPhotosSharedWith(email);
    const withRsvp = new Set(rsvpRefs.map((r) => `${r.ownerId}#${r.eventId}`));
    const refs = [...rsvpRefs, ...photoRefs.filter((r, i, all) => !withRsvp.has(`${r.ownerId}#${r.eventId}`) && all.findIndex((x) => x.ownerId === r.ownerId && x.eventId === r.eventId) === i)];
    const out: Array<EventView & { sharedBy: { id: string; name?: string; email?: string } }> = [];
    for (const { ownerId, eventId } of refs) {
      const e = await this.repo.getEvent(ownerId, eventId);
      if (!e) continue;
      const owner = await this.repo.getUser(ownerId);
      const view = await this.view({ userId: ownerId }, e);
      view.photoCount = (await this.repo.listPhotos(ownerId, eventId)).filter((p) => p.sharedWith.includes(email.toLowerCase())).length; // never the owner's total
      out.push({ ...(withRsvp.has(`${ownerId}#${eventId}`) ? view : { ...view, rsvp: null, attended: false, topScore: undefined }), sharedBy: { id: ownerId, name: owner?.name, email: owner?.email } });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ------------------------------------------------------------------ photos
  private get store(): PhotoStore {
    if (!this.d.photos) throw new AppError("invalid", "Photo storage is not configured on this server.");
    return this.d.photos;
  }
  private who = (ctx: Ctx) => encodeURIComponent(ctx.userId);
  private photoKeys = (ctx: Ctx, eventId: string, id: string) => ({ key: `p/${this.who(ctx)}/${eventId}/${id}`, thumbKey: `p/${this.who(ctx)}/${eventId}/${id}.thumb` });
  private tmpKeys = (ctx: Ctx, id: string) => ({ key: `tmp/${this.who(ctx)}/${id}`, thumbKey: `tmp/${this.who(ctx)}/${id}.thumb` });

  private async checkRoom(ctx: Ctx, eventId: string) {
    await this.mustEvent(ctx, eventId);
    if ((await this.repo.listPhotos(ctx.userId, eventId)).length >= MAX_PHOTOS_PER_EVENT) {
      throw new AppError("invalid", `A show can have at most ${MAX_PHOTOS_PER_EVENT} photos. Delete one first.`);
    }
  }
  private cleanCaption = (c?: string | null) => c?.trim().slice(0, 300) || undefined;

  /** Step 1 of a browser upload: signed URLs to send the file (and its small preview) straight to storage. */
  async requestPhotoUpload(ctx: Ctx, eventId: string, input: { contentType: string; bytes: number; thumbBytes?: number }) {
    if (!(PHOTO_TYPES as readonly string[]).includes(input.contentType)) throw new AppError("invalid", "Photos must be JPEG, PNG or WebP.");
    if (input.bytes <= 0 || input.bytes > MAX_PHOTO_BYTES) throw new AppError("invalid", `Photos can be at most ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
    if (input.thumbBytes !== undefined && (input.thumbBytes <= 0 || input.thumbBytes > MAX_THUMB_BYTES)) throw new AppError("invalid", "The preview image is too large.");
    await this.checkRoom(ctx, eventId);
    const photoId = randomUUID();
    const k = this.tmpKeys(ctx, photoId);
    return {
      photoId,
      upload: await this.store.presignPut(k.key, input.contentType, input.bytes),
      thumbUpload: input.thumbBytes ? await this.store.presignPut(k.thumbKey, "image/jpeg", input.thumbBytes) : undefined,
    };
  }

  /** Step 2: check what was uploaded really is a photo of an allowed size, then file it under the show. */
  async confirmPhoto(ctx: Ctx, eventId: string, photoId: string, caption?: string): Promise<PhotoView> {
    await this.checkRoom(ctx, eventId);
    const tmp = this.tmpKeys(ctx, photoId);
    const fin = this.photoKeys(ctx, eventId, photoId);
    const head = await this.store.head(tmp.key);
    if (!head) throw new AppError("not_found", "That upload was not found or has expired. Try again.");
    const drop = async () => { await this.store.delete(tmp.key); await this.store.delete(tmp.thumbKey); };
    const type = sniffImage((await this.store.peek(tmp.key, 12)) ?? new Uint8Array());
    if (!type || head.bytes > MAX_PHOTO_BYTES) { await drop(); throw new AppError("invalid", "That file is not a JPEG, PNG or WebP photo within the size limit."); }
    await this.store.copy(tmp.key, fin.key, type);
    let thumbKey: string | undefined;
    const th = await this.store.head(tmp.thumbKey);
    if (th && th.bytes <= MAX_THUMB_BYTES && sniffImage((await this.store.peek(tmp.thumbKey, 12)) ?? new Uint8Array()) === "image/jpeg") {
      await this.store.copy(tmp.thumbKey, fin.thumbKey, "image/jpeg");
      thumbKey = fin.thumbKey;
    }
    await drop();
    return this.savePhoto(ctx, eventId, photoId, { key: fin.key, thumbKey, contentType: type, bytes: head.bytes }, caption);
  }

  /** Imports an image the server downloads itself (public https URLs only). */
  async addPhotoFromUrl(ctx: Ctx, eventId: string, url: string, caption?: string): Promise<PhotoView> {
    await this.checkRoom(ctx, eventId);
    if (!this.d.fetchImage) throw new AppError("invalid", "Importing from a URL is not available on this server.");
    let got;
    try { got = await this.d.fetchImage(url, { maxBytes: MAX_PHOTO_BYTES }); }
    catch (e) { throw new AppError("invalid", `Could not download that image: ${(e as Error).message}`); }
    return this.storeBytes(ctx, eventId, got.data, caption);
  }

  /** Small images sent inline (base64), for tools that have the picture but no way to upload a file. */
  async addPhotoBase64(ctx: Ctx, eventId: string, data: string, caption?: string): Promise<PhotoView> {
    await this.checkRoom(ctx, eventId);
    const bytes = new Uint8Array(Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64"));
    if (bytes.length > MAX_INLINE_BYTES) throw new AppError("invalid", `Inline images can be at most ${MAX_INLINE_BYTES / 1024 / 1024} MB; use add_photo_from_url for larger ones.`);
    return this.storeBytes(ctx, eventId, bytes, caption);
  }

  private async storeBytes(ctx: Ctx, eventId: string, data: Uint8Array, caption?: string): Promise<PhotoView> {
    const type = sniffImage(data);
    if (!type || data.length > MAX_PHOTO_BYTES) throw new AppError("invalid", "That is not a JPEG, PNG or WebP photo within the size limit.");
    const id = randomUUID();
    const { key } = this.photoKeys(ctx, eventId, id);
    await this.store.put(key, data, type);
    return this.savePhoto(ctx, eventId, id, { key, contentType: type, bytes: data.length }, caption);
  }

  private async savePhoto(ctx: Ctx, eventId: string, id: string, f: { key: string; thumbKey?: string; contentType: PhotoType; bytes: number }, caption?: string): Promise<PhotoView> {
    // A new photo goes to the people tagged on the show (the ones with an email).
    const [rsvp, dir] = await Promise.all([this.repo.getRsvp(ctx.userId, eventId), this.directory(ctx)]);
    const me = ctx.email?.toLowerCase();
    const sharedWith = [...new Set((rsvp?.companions ?? []).map((n) => dir.get(personKey(n))?.email).filter((e): e is string => !!e && e !== me))];
    const photo: Photo = { id, eventId, ...f, caption: this.cleanCaption(caption), sharedWith, createdAt: this.now() };
    await this.repo.putPhoto(ctx.userId, photo);
    return this.photoView(ctx, photo, true);
  }

  private async photoView(ctx: Ctx, p: Photo, mine: boolean): Promise<PhotoView> {
    const url = await this.store.presignGet(p.key, 3600);
    const { key: _k, thumbKey, publicToken, ...rest } = p;
    const base = ctx.baseUrl ?? this.d.appUrl ?? "";
    return {
      ...rest,
      sharedWith: mine ? p.sharedWith : [],
      url, thumbUrl: thumbKey ? await this.store.presignGet(thumbKey, 3600) : url, mine,
      ...(mine && publicToken ? { publicUrl: `${base}/api/public/photos/${publicToken}` } : {}),
    };
  }

  /** My photos of a show; or, with `ownerId`, the ones that person shared with my email. */
  async listPhotos(ctx: Ctx, eventId: string, ownerId?: string): Promise<PhotoView[]> {
    if (!ownerId || ownerId === ctx.userId) {
      await this.mustEvent(ctx, eventId);
      const mine = (await this.repo.listPhotos(ctx.userId, eventId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.all(mine.map((p) => this.photoView(ctx, p, true)));
    }
    const email = (await this.ensureUser(ctx)).email?.toLowerCase();
    if (!email) return [];
    const shared = (await this.repo.listPhotos(ownerId, eventId)).filter((p) => p.sharedWith.includes(email)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Promise.all(shared.map((p) => this.photoView(ctx, p, false)));
  }

  private async myPhotos(ctx: Ctx, eventId: string, ids?: string[]) {
    await this.mustEvent(ctx, eventId);
    const all = await this.repo.listPhotos(ctx.userId, eventId);
    if (!ids) return all;
    const found = ids.map((id) => all.find((p) => p.id === id));
    if (found.some((p) => !p)) throw new AppError("not_found", "Photo not found on this show");
    return found as Photo[];
  }

  async updatePhoto(ctx: Ctx, eventId: string, photoId: string, caption: string | null) {
    const [p] = await this.myPhotos(ctx, eventId, [photoId]);
    const next = { ...p!, caption: this.cleanCaption(caption) };
    await this.repo.putPhoto(ctx.userId, next);
    return this.photoView(ctx, next, true);
  }

  async deletePhoto(ctx: Ctx, eventId: string, photoId: string) {
    const [p] = await this.myPhotos(ctx, eventId, [photoId]);
    await this.removePhoto(ctx, p!);
    return { deleted: photoId };
  }
  private async removePhoto(ctx: Ctx, p: Photo) {
    await this.repo.deletePhoto(ctx.userId, p.eventId, p.id);
    if (!this.d.photos) return;
    await this.d.photos.delete(p.key);
    if (p.thumbKey) await this.d.photos.delete(p.thumbKey);
  }

  /** Share photos (all of the show's, or the listed ones) with specific people. They see them under "Shared with me". */
  async sharePhotos(ctx: Ctx, eventId: string, emails: string[], photoIds?: string[]) {
    await this.ensureUser(ctx);
    const me = ctx.email?.toLowerCase();
    const add = emails.map((e) => e.trim().toLowerCase()).filter((e) => e && e !== me);
    return this.changePhotos(ctx, eventId, photoIds, (p) => ({ ...p, sharedWith: [...new Set([...p.sharedWith, ...add])] }));
  }
  async unsharePhotos(ctx: Ctx, eventId: string, emails: string[], photoIds?: string[]) {
    const drop = new Set(emails.map((e) => e.trim().toLowerCase()));
    return this.changePhotos(ctx, eventId, photoIds, (p) => ({ ...p, sharedWith: p.sharedWith.filter((e) => !drop.has(e)) }));
  }
  /** Turn the public link on (anyone with the link can see the photo) or off (the old link stops working). */
  async setPhotosPublic(ctx: Ctx, eventId: string, enabled: boolean, photoIds?: string[]) {
    return this.changePhotos(ctx, eventId, photoIds, (p) => ({ ...p, publicToken: enabled ? p.publicToken ?? randomBytes(24).toString("base64url") : undefined }));
  }
  private async changePhotos(ctx: Ctx, eventId: string, ids: string[] | undefined, fn: (p: Photo) => Photo) {
    const out: PhotoView[] = [];
    for (const p of await this.myPhotos(ctx, eventId, ids)) {
      const next = fn(p);
      await this.repo.putPhoto(ctx.userId, next);
      out.push(await this.photoView(ctx, next, true));
    }
    return out;
  }

  /** Short-lived storage URL behind a public link, or undefined when the link is unknown or revoked. */
  async publicPhotoUrl(token: string): Promise<string | undefined> {
    const ref = await this.repo.findPublicPhoto(token);
    const p = ref && (await this.repo.getPhoto(ref.ownerId, ref.eventId, ref.photoId));
    if (!p || p.publicToken !== token) return undefined;
    return this.store.presignGet(p.key, 300);
  }

  // ----------------------------------------------------------- year in review
  /** Attended shows in the range (optionally only with certain people), with their photos; what the review screens are built from. */
  private async buildReview(ownerId: string, recipe: ReviewRecipe, showNames: boolean): Promise<ReviewData> {
    if (recipe.from > recipe.to) throw new AppError("invalid", "The start date is after the end date");
    const owner: Ctx = { userId: ownerId };
    const { events } = await this.listEvents(owner, { from: recipe.from, to: recipe.to, rsvp: "attended", limit: 100000, sort: "asc" });
    const wanted = [...new Set((recipe.people ?? []).map(personKey).filter(Boolean))];
    const withPeople = events.filter((e) => {
      if (!wanted.length) return true;
      const here = new Set((e.rsvp?.companions ?? []).map(personKey));
      return recipe.match === "all" ? wanted.every((k) => here.has(k)) : wanted.some((k) => here.has(k));
    });
    const photosByEvent = new Map<string, Photo[]>();
    if (this.d.photos) {
      const ids = new Set(withPeople.map((e) => e.id));
      for (const p of (await this.repo.listAllPhotos(ownerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (ids.has(p.eventId)) photosByEvent.set(p.eventId, [...(photosByEvent.get(p.eventId) ?? []), p]);
      }
    }
    let budget = REVIEW_MAX_PHOTOS;
    const shows: ReviewShow[] = [];
    for (const e of withPeople) {
      const picked = (photosByEvent.get(e.id) ?? []).slice(0, Math.min(REVIEW_PHOTOS_PER_SHOW, budget));
      budget -= picked.length;
      const photos = await Promise.all(picked.map(async (p) => {
        const url = await this.store.presignGet(p.key, 3600);
        return { id: p.id, url, thumbUrl: p.thumbKey ? await this.store.presignGet(p.thumbKey, 3600) : url, ...(p.caption ? { caption: p.caption } : {}) };
      }));
      const companions = [...new Map((e.rsvp?.companions ?? []).map((c) => c.trim()).filter(Boolean).map((c) => [personKey(c), c])).values()];
      shows.push({
        date: e.date, title: e.title, ...(e.genre ? { genre: e.genre } : {}),
        ...(e.venue ? { venue: { name: nameAt(e.venue, e.date), ...(e.venue.city ? { city: e.venue.city } : {}) } } : {}),
        lineup: (e.lineup ?? []).map((a) => ({ name: a.name, ...(a.role ? { role: a.role } : {}) })),
        ...(e.topScore !== undefined ? { score: e.topScore } : {}),
        companions: showNames ? companions : [], companionCount: companions.length,
        songs: (e.setlists ?? []).flatMap((l) => l.songs.filter((x) => !x.tape).map((x) => ({ name: x.name, act: l.act }))).slice(0, 80),
        photos,
      });
    }
    const name = (await this.repo.getUser(ownerId))?.name?.trim().split(/\s+/)[0];
    return { recipe: { from: recipe.from, to: recipe.to, ...(wanted.length ? { people: recipe.people, match: recipe.match ?? "any" } : {}) }, ...(name ? { owner: name } : {}), shows };
  }

  /** The review for the signed-in user, with companion names. */
  async yearReview(ctx: Ctx, recipe: ReviewRecipe): Promise<ReviewData> { return this.buildReview(ctx.userId, recipe, true); }

  /** Make a link anyone can open (no sign-in). It stores only the recipe, so it always shows the current state of your shows and photos. */
  async createReviewLink(ctx: Ctx, recipe: ReviewRecipe, showNames: boolean) {
    if (recipe.from > recipe.to) throw new AppError("invalid", "The start date is after the end date");
    const link: ReviewLink = {
      token: randomBytes(24).toString("base64url"), ownerId: ctx.userId, showNames, createdAt: this.now(),
      recipe: { from: recipe.from, to: recipe.to, ...(recipe.people?.length ? { people: recipe.people, match: recipe.match ?? "any" } : {}) },
    };
    await this.repo.putReview(ctx.userId, link);
    return this.linkView(ctx, link);
  }
  private linkView(ctx: Ctx, l: ReviewLink) {
    return { token: l.token, url: `${ctx.baseUrl ?? this.d.appUrl ?? ""}/r/${l.token}`, recipe: l.recipe, showNames: l.showNames, createdAt: l.createdAt };
  }
  async listReviewLinks(ctx: Ctx) {
    return (await this.repo.listReviews(ctx.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((l) => this.linkView(ctx, l));
  }
  async revokeReviewLink(ctx: Ctx, token: string) {
    const l = await this.repo.findReview(token);
    if (!l || l.ownerId !== ctx.userId) throw new AppError("not_found", "Link not found");
    await this.repo.deleteReview(ctx.userId, token);
    return { revoked: token };
  }
  /** What the public page shows for a link, or undefined when it is unknown or revoked. */
  async publicReview(token: string): Promise<ReviewData | undefined> {
    const l = await this.repo.findReview(token);
    return l ? this.buildReview(l.ownerId, l.recipe, l.showNames) : undefined;
  }

  // ------------------------------------------------------------------ stats
  async stats(ctx: Ctx, opts: { year?: number } = {}) {
    const { events } = await this.listEvents(ctx, { limit: 100000 });
    const venueById = new Map((await this.repo.listVenues(ctx.userId)).map((v) => [v.id, v]));
    const attended = events.filter((e) => e.attended && (!opts.year || e.date.startsWith(String(opts.year))));
    const byVenue = new Map<string, { venueId: string | null; venue: string; city?: string; count: number }>();
    const byYear: Record<string, number> = {};
    const spent: Record<string, number> = {};
    for (const e of attended) {
      const key = e.venueId ?? "none";
      const row = byVenue.get(key) ?? { venueId: e.venueId ?? null, venue: e.venue?.name ?? "(no venue)", city: e.venue?.city, count: 0 };
      row.count++;
      const vv = e.venueId ? venueById.get(e.venueId) : undefined;
      if (vv) row.venue = this.currentName(vv); // one row per venue, under its current name
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
      upcomingGoing: events.filter((e) => e.rsvp?.status === "going" && !e.past).length,
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
      const body = buildCalendarEvent(event, rsvp, venue && { ...venue, name: nameAt(venue, event.date) }, ctx.userId, ctx.baseUrl ?? this.d.appUrl);
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
