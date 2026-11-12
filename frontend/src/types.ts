// Types come straight from the backend schemas so the two cannot drift.
import type { Act, Rsvp, ShowEvent, Song, Tier, Venue } from "../../backend/src/domain/schemas";

/** `past`: the date is over at the venue. `attended`: going + past, so you went (there is no separate stored status). */
export type EventView = ShowEvent & { venue: Venue | null; rsvp: Rsvp | null; past?: boolean; attended?: boolean; photoCount?: number; topScore?: number };
export type { Act, Rsvp, ShowEvent, Song, Tier, Venue };
export type RsvpStatus = Rsvp["status"];
export type { PhotoView } from "../../backend/src/domain/photos";
export type SharedEventView = EventView & { sharedBy: { id: string; name?: string; email?: string } };
export type VenueRow = Venue & { eventCount: number };
export type SyncResult = { status: "synced" | "removed" | "skipped" | "error"; message?: string };
export type CalendarStatus = { connected: boolean; connectedAs?: string; calendarId?: string; calendarName?: string; needsCalendarSelection: boolean };
export type Stats = {
  attendedTotal: number;
  attendedByVenue: Array<{ venueId: string | null; venue: string; city?: string; count: number }>;
  attendedByYear: Record<string, number>;
  totalSpent: Record<string, number>;
  upcomingGoing: number;
  undecidedUpcoming: number;
};
