import type { OAuthState, Repo } from "../domain/repo.js";
import type { Rsvp, ShowEvent, UserProfile, Venue } from "../domain/schemas.js";

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory Repo used by tests and local development. */
export class MemoryRepo implements Repo {
  users = new Map<string, UserProfile>();
  venues = new Map<string, Venue>();
  events = new Map<string, ShowEvent>();
  rsvps = new Map<string, Rsvp>();
  states = new Map<string, OAuthState>();

  private k = (u: string, id: string) => `${u}#${id}`;
  private scoped<T>(m: Map<string, T>, userId: string): T[] {
    return [...m.entries()].filter(([k]) => k.startsWith(`${userId}#`)).map(([, v]) => clone(v));
  }

  async getUser(id: string) { const u = this.users.get(id); return u && clone(u); }
  async putUser(u: UserProfile) { this.users.set(u.id, clone(u)); }
  async listUsers() { return [...this.users.values()].map(clone); }
  async findUserByEmail(email: string) {
    const e = email.toLowerCase();
    const u = [...this.users.values()].find((x) => x.email?.toLowerCase() === e);
    return u && clone(u);
  }

  async getVenue(u: string, id: string) { const v = this.venues.get(this.k(u, id)); return v && clone(v); }
  async listVenues(u: string) { return this.scoped(this.venues, u); }
  async putVenue(u: string, v: Venue) { this.venues.set(this.k(u, v.id), clone(v)); }
  async deleteVenue(u: string, id: string) { this.venues.delete(this.k(u, id)); }

  async getEvent(u: string, id: string) { const v = this.events.get(this.k(u, id)); return v && clone(v); }
  async listEvents(u: string) { return this.scoped(this.events, u); }
  async putEvent(u: string, e: ShowEvent) { this.events.set(this.k(u, e.id), clone(e)); }
  async deleteEvent(u: string, id: string) { this.events.delete(this.k(u, id)); }

  async getRsvp(u: string, eventId: string) { const v = this.rsvps.get(this.k(u, eventId)); return v && clone(v); }
  async listRsvps(u: string) { return this.scoped(this.rsvps, u); }
  async putRsvp(u: string, r: Rsvp) { this.rsvps.set(this.k(u, r.eventId), clone(r)); }
  async deleteRsvp(u: string, eventId: string) { this.rsvps.delete(this.k(u, eventId)); }
  async listSharedWith(email: string) {
    const e = email.toLowerCase();
    const out: Array<{ ownerId: string; eventId: string }> = [];
    for (const [key, r] of this.rsvps) {
      if (r.sharedWith.includes(e)) out.push({ ownerId: key.slice(0, key.indexOf("#")), eventId: r.eventId });
    }
    return out;
  }

  temps = new Map<string, { value: unknown; expiresAt: number }>();
  async putTemp(key: string, value: unknown, expiresAt: number) { this.temps.set(key, { value: clone(value), expiresAt }); }
  async getTemp<T>(key: string) {
    const t = this.temps.get(key);
    return t && t.expiresAt > Date.now() ? (clone(t.value) as T) : undefined;
  }
  async takeTemp<T>(key: string) {
    const t = this.temps.get(key);
    this.temps.delete(key);
    return t && t.expiresAt > Date.now() ? (clone(t.value) as T) : undefined;
  }

  async putOAuthState(s: string, v: OAuthState) { this.states.set(s, v); }
  async takeOAuthState(s: string) { const v = this.states.get(s); this.states.delete(s); return v; }
}
