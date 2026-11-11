import type { Rsvp, ShowEvent, UserProfile, Venue } from "./schemas.js";

/** A pending Google OAuth handshake, keyed by the random `state` value. */
export type OAuthState = { userId: string; expiresAt: number };

/** Storage port. Every method is scoped to the owning user. */
export interface Repo {
  getUser(userId: string): Promise<UserProfile | undefined>;
  putUser(user: UserProfile): Promise<void>;
  /** Every user profile (for scheduled jobs that sweep all accounts). */
  listUsers(): Promise<UserProfile[]>;

  getVenue(userId: string, id: string): Promise<Venue | undefined>;
  listVenues(userId: string): Promise<Venue[]>;
  putVenue(userId: string, venue: Venue): Promise<void>;
  deleteVenue(userId: string, id: string): Promise<void>;

  getEvent(userId: string, id: string): Promise<ShowEvent | undefined>;
  listEvents(userId: string): Promise<ShowEvent[]>;
  putEvent(userId: string, event: ShowEvent): Promise<void>;
  deleteEvent(userId: string, id: string): Promise<void>;

  getRsvp(userId: string, eventId: string): Promise<Rsvp | undefined>;
  listRsvps(userId: string): Promise<Rsvp[]>;
  /** Also maintains the share index for rsvp.sharedWith. */
  putRsvp(userId: string, rsvp: Rsvp): Promise<void>;
  deleteRsvp(userId: string, eventId: string): Promise<void>;
  /** RSVPs other users shared with this email: [ownerId, eventId]. */
  listSharedWith(email: string): Promise<Array<{ ownerId: string; eventId: string }>>;
  /** Resolve a user by email (for showing who shared). */
  findUserByEmail(email: string): Promise<UserProfile | undefined>;

  /** Short-lived records (OAuth registrations, authorize requests, codes). Callers must check expiry: DynamoDB TTL is lazy. */
  putTemp(key: string, value: unknown, expiresAt: number): Promise<void>;
  getTemp<T>(key: string): Promise<T | undefined>;
  /** Atomic read-and-delete (one-time use). */
  takeTemp<T>(key: string): Promise<T | undefined>;

  putOAuthState(state: string, value: OAuthState): Promise<void>;
  /** Atomic read-and-delete. */
  takeOAuthState(state: string): Promise<OAuthState | undefined>;
}
