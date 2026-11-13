import { z } from "zod";
import { EventInput, DateStr, PlaylistInput, RsvpInput, RsvpStatus, SaleStatus, SetlistInput, VenueInput } from "./domain/schemas.js";
import { ReviewRecipe } from "./domain/review.js";
import type { Ctx, Service } from "./domain/service.js";

/**
 * Every operation of the app, defined once. The MCP server exposes each as a tool and the
 * web frontend calls the very same operations over POST /api/ops/<name>.
 */
export type Op = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<any>;
  readOnly?: boolean;
  /** Only for the web app: not offered as an MCP tool. */
  uiOnly?: boolean;
  destructive?: boolean;
  run: (svc: Service, ctx: Ctx, input: any) => Promise<unknown>;
};

const op = <T extends z.ZodObject<any>>(o: Omit<Op, "input" | "run"> & { input: T; run: (svc: Service, ctx: Ctx, input: z.infer<T>) => Promise<unknown> }): Op => o as Op;

const EventWithVenue = EventInput.extend({
  venue: VenueInput.optional().describe("Venue to find by name or create. Preferred over venueId when adding scraped events."),
});

/** All fields optional, and null clears a field. Used for update operations. */
const nullablePartial = <T extends z.ZodObject<any>>(schema: T) =>
  z.object(Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, (v as z.ZodType).nullable().optional()]))) as unknown as z.ZodObject<{ [K in keyof T["shape"]]: z.ZodOptional<z.ZodNullable<T["shape"][K]>> }>;

const id = z.string().min(1);
const emails = z.array(z.string().email()).min(1);

export const ops: Op[] = [
  op({
    name: "whoami", title: "Who am I", readOnly: true,
    description: "Return the signed-in user and whether Google Calendar is connected.",
    input: z.object({}),
    run: (s, c) => s.whoAmI(c),
  }),

  // ---- events
  op({
    name: "list_events", title: "List events", readOnly: true,
    description:
      "List events (sorted by date) with venue and the user's RSVP inline. Filter by date range, venue, city, text (matches title, lineup, genre, venue), sale status, or RSVP state. " +
      "Shows other people tagged the user on are included, marked `tagged: true` (their details are read-only; the RSVP, score and photos are the user's own), with `taggedBy` naming who tagged them. " +
      "rsvp='none' returns events the user has not decided on yet: use it to present candidates to choose from. rsvp='going' is shows still ahead; rsvp='attended' is shows they were going to whose date has passed (every event also carries `past` and `attended` flags). Defaults to 100 results; use offset to page.",
    input: z.object({
      from: DateStr.optional(), to: DateStr.optional(),
      upcoming: z.boolean().optional().describe("Only events today or later"),
      venueId: z.string().optional(), city: z.string().optional(), text: z.string().optional(),
      saleStatus: SaleStatus.optional(),
      rsvp: z.enum(["none", "any", ...RsvpStatus.options]).optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
    }),
    run: (s, c, i) => s.listEvents(c, { ...i, tagged: true }),
  }),
  op({
    name: "get_event", title: "Get event", readOnly: true,
    description: "Get one event with its venue and RSVP.",
    input: z.object({ eventId: id }),
    run: (s, c, i) => s.getEvent(c, i.eventId),
  }),
  op({
    name: "create_event", title: "Create or update event",
    description:
      "Add one event, or update it if it already exists (upsert). Only title and date are required; fill in whatever is known. " +
      "VENUE: prefer venueId (call list_venues first and reuse its ids). If you only have a name, pass `venue` {name, city?, address?...}: it is matched to an existing venue " +
      "(ignoring case, accents and words like Club/Hall/Teatro, so 'Fabrique' finds 'Fabrique Club'; a different city never matches), and a new venue is created only if nothing matches. " +
      "The result says venueNote when a similar name was matched and venueCreated when a venue was created, so check them. An ambiguous name returns an error listing the candidates: retry with venueId. " +
      "DUPLICATES: an event on the same date at the same venue (or with the same title and date when a venue is unknown) is the same show. Its stored fields are updated with the ones you pass; fields you omit are kept. " +
      "MOVED SHOWS: a future show with the same date and exact title at a different venue is treated as the same show that moved, and its venue is changed (result.venueChanged lists from/to) " +
      "unless several shows match, or both lineups are given and share no act. To keep two same-titled shows apart, give them different lineups or titles. " +
      "The result has created, updated, changedFields and duplicateOf. Pass ifDuplicate='skip' to leave an existing event untouched instead.",
    input: EventWithVenue.extend({ ifDuplicate: z.enum(["update", "skip"]).optional().describe("What to do when the show already exists. Default: update") }),
    run: (s, c, { ifDuplicate, ...i }) => s.createEvent(c, i, ifDuplicate ?? "update"),
  }),
  op({
    name: "bulk_create_events", title: "Create or update many events",
    description:
      "Add many events in one call (up to 100), e.g. after scraping a venue or ticketing site. Each one follows create_event: venues are matched by id or similar name, " +
      "and a show that already exists (same date at the same venue, or the same title and date at another venue, which means it moved) is updated in place with the fields given. " +
      "Entries in one call never move each other, so two same-titled shows at different venues on one day stay separate. " +
      "Returns created, updated (with changedFields), unchanged, failed, venuesCreated and venuesMatchedBySimilarName: review the last two for mistakes. " +
      "Pass venueId when you know it (list_venues first). Afterwards call list_events with rsvp='none' to present the candidates.",
    input: z.object({
      events: z.array(EventWithVenue).min(1).max(100),
      ifDuplicate: z.enum(["update", "skip"]).optional().describe("What to do with shows that already exist. Default: update"),
    }),
    run: (s, c, i) => s.bulkCreateEvents(c, i.events, i.ifDuplicate ?? "update"),
  }),
  op({
    name: "update_event", title: "Update event",
    description: "Change fields of an event. Only the fields you pass change; arrays (lineup, tiers) are replaced whole; pass null to clear a field. Updates the calendar entry if the user is going.",
    input: z.object({ eventId: id, changes: nullablePartial(EventWithVenue) }),
    run: (s, c, i) => s.updateEvent(c, i.eventId, i.changes),
  }),
  op({
    name: "delete_event", title: "Delete event", destructive: true,
    description: "Delete an event, its RSVP and its calendar entry.",
    input: z.object({ eventId: id }),
    run: (s, c, i) => s.deleteEvent(c, i.eventId),
  }),

  // ---- setlists
  op({
    name: "sync_setlist", title: "Fetch setlist",
    description:
      "Look up the setlist of a past show on setlist.fm (one lookup per act in the lineup) and store it on the event. " +
      "Safe to repeat: it keeps what is stored when nothing is found, and never replaces a manually entered setlist unless force=true. " +
      "Setlists are often posted a day or two after the show. The result lists per act whether it was found, not found, kept (manual) or failed.",
    input: z.object({ eventId: id, force: z.boolean().optional().describe("Also replace setlists that were entered by hand") }),
    run: (s, c, i) => s.syncSetlists(c, i.eventId, { force: i.force }),
  }),
  op({
    name: "set_setlist", title: "Set setlist",
    description:
      "Store the songs one act played at a show, by hand (use this when setlist.fm has nothing or is wrong). Replaces that act's setlist; an empty songs list removes it. " +
      "Use `section` for encores. Manual setlists are not overwritten by sync_setlist.",
    input: SetlistInput.extend({ eventId: id }),
    run: (s, c, { eventId, ...setlist }) => s.setSetlist(c, eventId, setlist),
  }),

  // ---- playlists
  op({
    name: "get_recent_setlists", title: "Recent setlists of the lineup", readOnly: true,
    description:
      "For building a playlist for a show (usually one the user is going to): what each act of the lineup played at its most recent shows on setlist.fm, newest first (default 5 per act, max 10; only shows before this event's date). " +
      "Nothing is stored. Returns per act: status found / none / error and setlists [{date, venue, city, url, songs}], plus the event's current `playlists`. " +
      "Pick the songs yourself (e.g. the ones played most often), create the playlist on the streaming service with the user's own access, then save the link with set_playlist.",
    input: z.object({ eventId: id, limit: z.number().int().min(1).max(10).optional().describe("Setlists per act, default 5") }),
    run: (s, c, i) => s.recentSetlists(c, i.eventId, { limit: i.limit }),
  }),
  op({
    name: "set_playlist", title: "Save playlist link",
    description:
      "Attach a playlist you created for one act of a show: act, service (lower case, 'spotify' for now), url, optional title and trackCount. " +
      "One playlist per act and service: saving again replaces it. url null removes it. The app shows these in the event's Playlists section.",
    input: PlaylistInput.extend({ eventId: id }),
    run: (s, c, { eventId, ...playlist }) => s.setPlaylist(c, eventId, playlist),
  }),

  // ---- rsvp
  op({
    name: "set_rsvp", title: "RSVP to a show",
    description:
      "Create or update the user's RSVP for an event (one per event). Status: interested, going (includes 'bought tickets'; record tier/price/fees here), skipped. " +
      "There is no separate 'attended' status: a show you are going to counts as attended once its date has passed, so only mark it skipped if you ended up not going ('attended' is still accepted and saved as going). " +
      "'going' is pushed to Google Calendar; other statuses remove the entry. Returns `warnings` when the show overlaps another show the user is going to (warn, never blocks).",
    input: z.object({ eventId: id }).extend(RsvpInput.shape),
    run: (s, c, { eventId, ...rsvp }) => s.setRsvp(c, eventId, rsvp),
  }),
  op({
    name: "set_scores", title: "Score a show",
    description:
      "Score the acts of a show the user attended (going, date passed), 0-10 in steps of 0.5: `actScores` maps act name -> score. " +
      "Lists show the best act score of the show (`topScore`). For a show with a single act (or no lineup) pass `score` instead. " +
      "Act scores merge into the existing ones; null clears one act (or all with actScores null). Lighter than set_rsvp: no calendar sync.",
    input: z.object({ eventId: id, score: RsvpInput.shape.score, actScores: RsvpInput.shape.actScores }),
    run: (s, c, i) => s.setScores(c, i.eventId, i),
  }),
  op({
    name: "remove_rsvp", title: "Remove RSVP", destructive: true,
    description: "Remove the RSVP (and its calendar entry). The event stays in the list as undecided.",
    input: z.object({ eventId: id }),
    run: (s, c, i) => s.removeRsvp(c, i.eventId),
  }),
  // ---- photos
  op({
    name: "request_photo_upload", title: "Start a photo upload",
    description:
      "Browser upload step 1: returns signed URLs to PUT a photo (JPEG, PNG or WebP, up to 10 MB) and optionally a small JPEG preview straight to storage, then call confirm_photo. " +
      "Max 20 photos per show. From an AI assistant use add_photo_from_url or add_photo_base64 instead.",
    input: z.object({ eventId: id, contentType: z.string(), bytes: z.number().int().positive(), thumbBytes: z.number().int().positive().optional() }),
    run: (s, c, { eventId, ...i }) => s.requestPhotoUpload(c, eventId, i),
  }),
  op({
    name: "confirm_photo", title: "Finish a photo upload",
    description: "Browser upload step 2: after the file was PUT to the URL from request_photo_upload, attach it to the show.",
    input: z.object({ eventId: id, photoId: id, caption: z.string().max(300).optional() }),
    run: (s, c, i) => s.confirmPhoto(c, i.eventId, i.photoId, i.caption),
  }),
  op({
    name: "add_photo_from_url", title: "Add a photo from a URL",
    description:
      "Attach a photo to a show by giving a public https image URL (JPEG, PNG or WebP, up to 10 MB). The server downloads and stores it. " +
      "Photos are private to the user by default; use share_photos or set_photos_public to share them.",
    input: z.object({ eventId: id, url: z.string().url(), caption: z.string().max(300).optional() }),
    run: (s, c, i) => s.addPhotoFromUrl(c, i.eventId, i.url, i.caption),
  }),
  op({
    name: "add_photo_base64", title: "Add a photo (inline)",
    description: "Attach a small photo (JPEG, PNG or WebP, up to 1 MB) sent as base64 text. For anything larger use add_photo_from_url.",
    input: z.object({ eventId: id, data: z.string().min(1).describe("Base64 of the image bytes (a data: URL is also accepted)"), caption: z.string().max(300).optional() }),
    run: (s, c, i) => s.addPhotoBase64(c, i.eventId, i.data, i.caption),
  }),
  op({
    name: "list_photos", title: "List photos of a show", readOnly: true,
    description: "Photos of a show with signed view URLs (valid for an hour). Give `ownerId` (the sharedBy id from list_shared_with_me) to list the photos someone shared with the user.",
    input: z.object({ eventId: id, ownerId: z.string().optional() }),
    run: (s, c, i) => s.listPhotos(c, i.eventId, i.ownerId),
  }),
  op({
    name: "update_photo", title: "Edit a photo caption",
    description: "Set or clear (null) the caption of one of the user's photos.",
    input: z.object({ eventId: id, photoId: id, caption: z.string().max(300).nullable() }),
    run: (s, c, i) => s.updatePhoto(c, i.eventId, i.photoId, i.caption),
  }),
  op({
    name: "delete_photo", title: "Delete a photo", destructive: true,
    description: "Delete one of the user's photos for good (the stored file too).",
    input: z.object({ eventId: id, photoId: id }),
    run: (s, c, i) => s.deletePhoto(c, i.eventId, i.photoId),
  }),
  op({
    name: "share_photos", title: "Share photos",
    description: "Share a show's photos (all, or the listed photoIds) with specific people by email. They see them under 'shared with me'. Photos are private until shared.",
    input: z.object({ eventId: id, emails, photoIds: z.array(id).optional() }),
    run: (s, c, i) => s.sharePhotos(c, i.eventId, i.emails, i.photoIds),
  }),
  op({
    name: "unshare_photos", title: "Stop sharing photos",
    description: "Stop sharing a show's photos (all, or the listed photoIds) with these emails.",
    input: z.object({ eventId: id, emails, photoIds: z.array(id).optional() }),
    run: (s, c, i) => s.unsharePhotos(c, i.eventId, i.emails, i.photoIds),
  }),
  op({
    name: "set_photos_public", title: "Public link for photos",
    description: "Turn the public link on or off for a show's photos (all, or the listed photoIds). On: anyone with a photo's `publicUrl` can see it. Off: the link stops working for good.",
    input: z.object({ eventId: id, enabled: z.boolean(), photoIds: z.array(id).optional() }),
    run: (s, c, i) => s.setPhotosPublic(c, i.eventId, i.enabled, i.photoIds),
  }),
  op({
    name: "list_rsvps", title: "List RSVPs", readOnly: true,
    description: "List events the user has RSVP'd to, optionally by status.",
    input: z.object({ status: RsvpStatus.optional() }),
    run: (s, c, i) => s.listRsvps(c, i.status),
  }),
  op({
    name: "share_rsvp", title: "Share RSVP",
    description: "Share an RSVP (and its event) with other people by email so they see it under 'shared with me'. They can have an account or sign up later with that email.",
    input: z.object({ eventId: id, emails }),
    run: (s, c, i) => s.shareRsvp(c, i.eventId, i.emails),
  }),
  op({
    name: "unshare_rsvp", title: "Stop sharing RSVP",
    description: "Stop sharing an RSVP with the given emails.",
    input: z.object({ eventId: id, emails }),
    run: (s, c, i) => s.unshareRsvp(c, i.eventId, i.emails),
  }),
  op({
    name: "list_people", title: "List people", readOnly: true,
    description: "People from 'Going with' that have an email: name and email. Shows with these people are shared with their email.",
    input: z.object({}),
    run: (s, c) => s.listPeople(c),
  }),
  op({
    name: "set_person_email", title: "Link a person to an email",
    description:
      "Set (or clear with null) the email of someone in 'Going with'. It applies to every show they are on, past and upcoming: those shows and their photos are shared with that email, " +
      "so they see them under 'shared with me' (now, or once they sign up). Unlinking stops the sharing for those shows.",
    input: z.object({ name: z.string().min(1).describe("The person's name as used in 'Going with'"), email: z.string().email().nullable() }),
    run: (s, c, i) => s.setPersonEmail(c, i.name, i.email),
  }),
  op({
    name: "list_tag_losses", title: "Shows I was taken off of", readOnly: true,
    description: "Shows the user answered (RSVP, score or photos) after being tagged, which the owner has since taken them off or deleted. Each can be kept as the user's own show or let go (resolve_tag_loss).",
    input: z.object({}),
    run: (s, c) => s.listTagLosses(c),
  }),
  op({
    name: "resolve_tag_loss", title: "Keep or drop a show I was taken off of",
    description: "keep=true makes the show one of the user's own, with their RSVP, score and photos. keep=false deletes their RSVP, score and photos of it.",
    input: z.object({ ownerId: id, eventId: id, keep: z.boolean() }),
    run: (s, c, i) => s.resolveTagLoss(c, i.ownerId, i.eventId, i.keep),
  }),
  op({
    name: "list_shared_with_me", title: "Shared with me", readOnly: true,
    description: "RSVPs other people have shared with the signed-in user's email (read-only).",
    input: z.object({}),
    run: (s, c) => s.listSharedWithMe(c),
  }),

  // ---- venues
  op({
    name: "list_venues", title: "List venues", readOnly: true,
    description: "List active venues with how many events each has. Retired (closed) venues are left out unless includeRetired is true.",
    input: z.object({ text: z.string().optional(), includeRetired: z.boolean().optional().describe("Also return retired venues") }),
    run: (s, c, i) => s.listVenues(c, i),
  }),
  op({
    name: "get_venue", title: "Get venue", readOnly: true,
    description: "Get one venue.",
    input: z.object({ venueId: id }),
    run: (s, c, i) => s.getVenue(c, i.venueId),
  }),
  op({
    name: "create_venue", title: "Create venue",
    description: "Create a venue. The address is used as the native location on calendar entries, so give a full street address when known.",
    input: VenueInput,
    run: (s, c, i) => s.createVenue(c, i),
  }),
  op({
    name: "update_venue", title: "Update venue",
    description: "Change fields of a venue; calendar entries of events there are refreshed. A different `name` here only CORRECTS the current name (a typo). If the venue was really renamed, use rename_venue with the date it changed.",
    input: z.object({ venueId: id, changes: nullablePartial(VenueInput) }),
    run: (s, c, i) => s.updateVenue(c, i.venueId, i.changes),
  }),
  op({
    name: "retire_venue", title: "Retire venue",
    description: "Mark a venue as closed so it no longer appears in list_venues. Its past events, RSVPs and stats are kept. Reversible with unretire_venue. Prefer this over delete_venue.",
    input: z.object({ venueId: id }),
    run: (s, c, i) => s.retireVenue(c, i.venueId),
  }),
  op({
    name: "unretire_venue", title: "Unretire venue",
    description: "Bring a retired venue back into list_venues (it reopened, or was retired by mistake).",
    input: z.object({ venueId: id }),
    run: (s, c, i) => s.unretireVenue(c, i.venueId),
  }),
  op({
    name: "delete_venue", title: "Delete venue", destructive: true,
    description: "Delete a venue that has no events. Use merge_venues for duplicates.",
    input: z.object({ venueId: id }),
    run: (s, c, i) => s.deleteVenue(c, i.venueId),
  }),
  op({
    name: "merge_venues", title: "Merge venues", destructive: true,
    description: "Move all events from one venue to another and delete the first (for duplicates created by scraping).",
    input: z.object({
      fromVenueId: id, intoVenueId: id,
      nameChangedOn: DateStr.optional().describe("Day the surviving venue's name (intoVenueId) started being used, when the two are the same place under an old and a new name. The merged-away venue's name then applies before that day and is kept in the venue's name history. Omit if unknown: old names stay searchable but shows display the surviving name."),
    }),
    run: (s, c, i) => s.mergeVenues(c, i.fromVenueId, i.intoVenueId, i.nameChangedOn),
  }),
  op({
    name: "rename_venue", title: "Rename venue",
    description: "Record that a venue changed its name. effectiveFrom is the day the new name actually started (not the day you found out): shows on or after it display the new name, earlier shows keep the old one, and filtering by venue still returns all of its shows. Old names stay matchable, so an event sent with the old name still resolves to this venue. Use this instead of retire_venue + create_venue; retire_venue is only for venues that closed.",
    input: z.object({ venueId: id, name: z.string().min(1).describe("The new name"), effectiveFrom: DateStr.describe("YYYY-MM-DD the new name started applying (required)") }),
    run: (s, c, i) => s.renameVenue(c, i.venueId, i.name, i.effectiveFrom),
  }),
  op({
    name: "remove_venue_name", title: "Remove venue name", destructive: true,
    description: "Remove a name from a venue's name history (recorded by mistake). The venue keeps at least one name.",
    input: z.object({ venueId: id, name: z.string().min(1) }),
    run: (s, c, i) => s.removeVenueName(c, i.venueId, i.name),
  }),

  // ---- stats
  op({
    name: "get_stats", title: "Concert stats", readOnly: true,
    description: "Totals for attended shows (going to a show whose date has passed): by venue, by year, money spent (price + fees), plus upcoming going and undecided counts.",
    input: z.object({ year: z.number().int().optional() }),
    run: (s, c, i) => s.stats(c, i),
  }),

  // ---- calendar
  op({
    name: "calendar_status", title: "Calendar status", readOnly: true,
    description: "Whether Google Calendar is connected and which calendar is selected.",
    input: z.object({}),
    run: (s, c) => s.calendarStatus(c),
  }),
  op({
    name: "calendar_connect", title: "Connect Google Calendar",
    description: "Return a link the user must open in a browser to grant Google Calendar access. Afterwards call calendar_list and calendar_select.",
    input: z.object({}),
    run: (s, c) => s.calendarConnectUrl(c),
  }),
  op({
    name: "calendar_list", title: "List calendars", readOnly: true,
    description: "List the user's writable Google calendars and the currently selected one.",
    input: z.object({}),
    run: (s, c) => s.calendarList(c),
  }),
  op({
    name: "calendar_select", title: "Select calendar",
    description: "Choose which calendar receives the shows: pass calendarId of an existing one, or createName to make a dedicated one. Re-syncs all going RSVPs to it.",
    input: z.object({ calendarId: z.string().optional(), createName: z.string().optional() }),
    run: (s, c, i) => s.calendarSelect(c, i),
  }),
  op({
    name: "calendar_resync", title: "Re-sync calendar",
    description: "Push every going RSVP to the selected calendar again (fixes entries deleted by hand).",
    input: z.object({}),
    run: (s, c) => s.resyncAll(c),
  }),
  op({
    name: "calendar_disconnect", title: "Disconnect calendar", destructive: true,
    description: "Forget the Google connection. With removeEvents=true also deletes the calendar entries this app created.",
    input: z.object({ removeEvents: z.boolean().optional() }),
    run: (s, c, i) => s.calendarDisconnect(c, i),
  }),
  // ---- year in review (web app only)
  op({
    name: "year_review", title: "Recap", readOnly: true, uiOnly: true,
    description: "The shows you attended in a date range (optionally only with certain people), with photos, for the year-in-review screen.",
    input: ReviewRecipe,
    run: (s, c, i) => s.yearReview(c, i),
  }),
  op({
    name: "create_review_link", title: "Share a recap", uiOnly: true,
    description: "Create a public, unlisted link to a year in review. Anyone with the link can see it; it shows the current photos of the matching shows.",
    input: ReviewRecipe.extend({ showNames: z.boolean().default(false).describe("Show the names of the people you went with") }),
    run: (s, c, { showNames, ...recipe }) => s.createReviewLink(c, recipe, showNames),
  }),
  op({
    name: "list_review_links", title: "List shared reviews", readOnly: true, uiOnly: true,
    description: "Your shared year-in-review links.",
    input: z.object({}),
    run: (s, c) => s.listReviewLinks(c),
  }),
  op({
    name: "revoke_review_link", title: "Stop sharing a review", destructive: true, uiOnly: true,
    description: "Revoke a shared year-in-review link; it stops working immediately.",
    input: z.object({ token: id }),
    run: (s, c, i) => s.revokeReviewLink(c, i.token),
  }),
];

export const opsByName = new Map(ops.map((o) => [o.name, o]));
