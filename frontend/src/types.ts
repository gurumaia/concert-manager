// Types come straight from the backend schemas so the two cannot drift.
import type { Act, Rsvp, ShowEvent, Tier, Venue } from "../../backend/src/domain/schemas";

export type EventView = ShowEvent & { venue: Venue | null; rsvp: Rsvp | null };
export type { Act, Rsvp, ShowEvent, Tier, Venue };
export type RsvpStatus = Rsvp["status"];
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
