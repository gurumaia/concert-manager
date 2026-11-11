import { z } from "zod";

/** YYYY-MM-DD */
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
/** HH:MM, 24h, venue local time */
export const TimeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24h)");
const Email = z.string().email().transform((s) => s.trim().toLowerCase());

export const Act = z.object({
  name: z.string().min(1),
  role: z.enum(["headliner", "support", "opener", "guest"]).optional(),
  startTime: TimeStr.optional().describe("Set time for this act, if known"),
});
export type Act = z.infer<typeof Act>;

export const Tier = z.object({
  name: z.string().min(1).describe("e.g. Pista, Cadeira Inferior, VIP, Meia"),
  price: z.number().nonnegative().optional().describe("Face value, without fees"),
  fee: z.number().nonnegative().optional().describe("Service fee on top of price, shown separately"),
  currency: z.string().length(3).optional().describe("ISO 4217, defaults to the event currency"),
  notes: z.string().optional(),
});
export type Tier = z.infer<typeof Tier>;

export const SaleStatus = z.enum(["unknown", "announced", "on_sale", "sold_out", "cancelled", "postponed"]);

// ---- Venue ----
export const VenueInput = z.object({
  name: z.string().min(1),
  address: z.string().optional().describe("Street address; used as the native Google Calendar location"),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  timezone: z.string().optional().describe("IANA zone, e.g. America/Sao_Paulo"),
  capacity: z.number().int().positive().optional(),
  website: z.string().url().optional(),
  mapsUrl: z.string().url().optional(),
  notes: z.string().optional(),
});
export type VenueInput = z.infer<typeof VenueInput>;
/** A name a venue has had. `from` is the first day it applied; no `from` means "since before we track" (the first name). */
export type VenueName = { name: string; from?: string };
/**
 * retiredAt is set when a venue closed: hidden from list_venues by default, but its events and stats stay.
 * `names` is the venue's naming history (a rename is not a closure); `name` is the one in effect today. Absent = one undated name.
 */
export type Venue = VenueInput & { id: string; createdAt: string; updatedAt: string; retiredAt?: string; names?: VenueName[];
  /** Only on a venue inside an event view: `name` is the name on the show's date, this is the name today. */
  currentName?: string;
};

// ---- Event ----
export const EventInput = z.object({
  title: z.string().min(1),
  date: DateStr,
  doorsTime: TimeStr.optional(),
  startTime: TimeStr.optional(),
  endTime: TimeStr.optional(),
  venueId: z.string().optional().describe("Id of an existing venue; or pass `venue` to find-or-create by name"),
  lineup: z.array(Act).optional().describe("All acts on the bill, headliner first"),
  tiers: z.array(Tier).optional(),
  currency: z.string().length(3).optional().describe("Default currency for tiers, defaults to BRL"),
  ticketUrl: z.string().url().optional(),
  sourceUrl: z.string().url().optional().describe("Where this event was found"),
  genre: z.string().optional(),
  ageRating: z.string().optional(),
  saleStatus: SaleStatus.optional(),
  onSaleDate: DateStr.optional(),
  description: z.string().optional(),
  notes: z.string().optional(),
});
export type EventInput = z.infer<typeof EventInput>;
// ---- Setlist ----
export const Song = z.object({
  name: z.string().min(1),
  cover: z.string().optional().describe("Original artist, when this is a cover"),
  info: z.string().optional().describe("Note such as 'acoustic' or 'with Guest'"),
  tape: z.boolean().optional().describe("Played from tape / not live"),
  section: z.string().optional().describe("Group the song belongs to, e.g. 'Encore'. Omit for the main set."),
});
export type Song = z.infer<typeof Song>;

export const SetlistInput = z.object({
  act: z.string().min(1).describe("Which act of the lineup played this set"),
  songs: z.array(Song).describe("In playing order. An empty list removes the setlist for this act."),
  url: z.string().url().optional().describe("Where the setlist came from"),
});
export type SetlistInput = z.infer<typeof SetlistInput>;
/** `manual` setlists are never overwritten by an automatic lookup. */
export type Setlist = { act: string; songs: Song[]; url?: string; source: "setlist.fm" | "manual"; fetchedAt: string };

export type ShowEvent = Omit<EventInput, "venueId"> & {
  id: string;
  venueId?: string;
  setlists?: Setlist[];
  createdAt: string;
  updatedAt: string;
};

// ---- RSVP ----
// "attended" is retired: going + a past date means you went. It is still accepted as input (saved as going) and read from old data.
export const RsvpStatus = z.enum(["interested", "going", "skipped", "attended"]);
export type RsvpStatus = z.infer<typeof RsvpStatus>;

export const RsvpInput = z.object({
  status: RsvpStatus,
  tierName: z.string().optional(),
  quantity: z.number().int().positive().optional().describe("Number of tickets"),
  pricePaid: z.number().nonnegative().optional().describe("Total ticket price paid, without fees"),
  feesPaid: z.number().nonnegative().optional(),
  companions: z.array(z.string()).optional().describe("Who is going along"),
  notes: z.string().optional(),
});
export type RsvpInput = z.infer<typeof RsvpInput>;
export type Rsvp = RsvpInput & {
  eventId: string;
  sharedWith: string[];
  calendarId?: string;
  calendarEventId?: string;
  createdAt: string;
  updatedAt: string;
};

export { Email };

// ---- User ----
export type UserProfile = {
  id: string;
  email?: string;
  name?: string;
  calendar?: {
    connectedAs?: string;
    refreshTokenEnc: string;
    calendarId?: string;
    calendarName?: string;
  };
  createdAt: string;
};
