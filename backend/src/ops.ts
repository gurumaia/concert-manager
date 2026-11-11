import { z } from "zod";
import { EventInput, DateStr, RsvpInput, RsvpStatus, SaleStatus, VenueInput } from "./domain/schemas.js";
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
      "rsvp='none' returns events the user has not decided on yet: use it to present candidates to choose from. Defaults to 100 results; use offset to page.",
    input: z.object({
      from: DateStr.optional(), to: DateStr.optional(),
      upcoming: z.boolean().optional().describe("Only events today or later"),
      venueId: z.string().optional(), city: z.string().optional(), text: z.string().optional(),
      saleStatus: SaleStatus.optional(),
      rsvp: z.enum(["none", "any", ...RsvpStatus.options]).optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
    }),
    run: (s, c, i) => s.listEvents(c, i),
  }),
  op({
    name: "get_event", title: "Get event", readOnly: true,
    description: "Get one event with its venue and RSVP.",
    input: z.object({ eventId: id }),
    run: (s, c, i) => s.getEvent(c, i.eventId),
  }),
  op({
    name: "create_event", title: "Create event",
    description:
      "Add one event. Only title and date are required; fill in whatever is known. Pass `venue` (name + address etc.) to find-or-create the venue by name. " +
      "If an event with the same date and title already exists it is returned instead of duplicating (created=false).",
    input: EventWithVenue,
    run: (s, c, i) => s.createEvent(c, i),
  }),
  op({
    name: "bulk_create_events", title: "Create many events",
    description:
      "Add many events in one call (up to 100), e.g. after scraping a venue or ticketing site. Duplicates (same date + title) are skipped and reported. " +
      "Returns created, skipped and failed lists. Afterwards call list_events with rsvp='none' to present the candidates.",
    input: z.object({ events: z.array(EventWithVenue).min(1).max(100) }),
    run: (s, c, i) => s.bulkCreateEvents(c, i.events),
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

  // ---- rsvp
  op({
    name: "set_rsvp", title: "RSVP to a show",
    description:
      "Create or update the user's RSVP for an event (one per event). Status: interested, going (includes 'bought tickets'; record tier/price/fees here), skipped, attended. " +
      "'going' and 'attended' are pushed to Google Calendar; other statuses remove the entry. Returns `warnings` when the show overlaps another show the user is going to (warn, never blocks).",
    input: z.object({ eventId: id }).extend(RsvpInput.shape),
    run: (s, c, { eventId, ...rsvp }) => s.setRsvp(c, eventId, rsvp),
  }),
  op({
    name: "remove_rsvp", title: "Remove RSVP", destructive: true,
    description: "Remove the RSVP (and its calendar entry). The event stays in the list as undecided.",
    input: z.object({ eventId: id }),
    run: (s, c, i) => s.removeRsvp(c, i.eventId),
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
    name: "list_shared_with_me", title: "Shared with me", readOnly: true,
    description: "RSVPs other people have shared with the signed-in user's email (read-only).",
    input: z.object({}),
    run: (s, c) => s.listSharedWithMe(c),
  }),

  // ---- venues
  op({
    name: "list_venues", title: "List venues", readOnly: true,
    description: "List venues with how many events each has.",
    input: z.object({ text: z.string().optional() }),
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
    description: "Change fields of a venue; calendar entries of events there are refreshed.",
    input: z.object({ venueId: id, changes: nullablePartial(VenueInput) }),
    run: (s, c, i) => s.updateVenue(c, i.venueId, i.changes),
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
    input: z.object({ fromVenueId: id, intoVenueId: id }),
    run: (s, c, i) => s.mergeVenues(c, i.fromVenueId, i.intoVenueId),
  }),

  // ---- stats
  op({
    name: "get_stats", title: "Concert stats", readOnly: true,
    description: "Totals for attended shows: by venue, by year, money spent (price + fees), plus upcoming going and undecided counts.",
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
    description: "Choose which calendar receives the shows: pass calendarId of an existing one, or createName to make a dedicated one. Re-syncs all going/attended RSVPs to it.",
    input: z.object({ calendarId: z.string().optional(), createName: z.string().optional() }),
    run: (s, c, i) => s.calendarSelect(c, i),
  }),
  op({
    name: "calendar_resync", title: "Re-sync calendar",
    description: "Push every going/attended RSVP to the selected calendar again (fixes entries deleted by hand).",
    input: z.object({}),
    run: (s, c) => s.resyncAll(c),
  }),
  op({
    name: "calendar_disconnect", title: "Disconnect calendar", destructive: true,
    description: "Forget the Google connection. With removeEvents=true also deletes the calendar entries this app created.",
    input: z.object({ removeEvents: z.boolean().optional() }),
    run: (s, c, i) => s.calendarDisconnect(c, i),
  }),
];

export const opsByName = new Map(ops.map((o) => [o.name, o]));
