import type { OAuthState, Repo } from "../domain/repo.js";
import type { Photo, PhotoRef } from "../domain/photos.js";
import type { ReviewLink } from "../domain/review.js";
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

  photos = new Map<string, Photo>(); // key: user#eventId#photoId
  async getPhoto(u: string, eventId: string, id: string) { const v = this.photos.get(this.k(u, `${eventId}#${id}`)); return v && clone(v); }
  async listPhotos(u: string, eventId: string) {
    return [...this.photos.entries()].filter(([k]) => k.startsWith(`${u}#${eventId}#`)).map(([, v]) => clone(v));
  }
  async listAllPhotos(u: string) { return [...this.photos.entries()].filter(([k]) => k.startsWith(`${u}#`)).map(([, v]) => clone(v)); }
  async putPhoto(u: string, p: Photo) { this.photos.set(this.k(u, `${p.eventId}#${p.id}`), clone({ ...p, sharedWith: p.sharedWith.map((e) => e.toLowerCase()) })); }
  async deletePhoto(u: string, eventId: string, id: string) { this.photos.delete(this.k(u, `${eventId}#${id}`)); }
  async listPhotosSharedWith(email: string): Promise<PhotoRef[]> {
    const e = email.toLowerCase();
    return [...this.photos.entries()].filter(([, p]) => p.sharedWith.includes(e)).map(([k, p]) => ({ ownerId: k.slice(0, k.indexOf("#")), eventId: p.eventId, photoId: p.id }));
  }
  async findPublicPhoto(token: string): Promise<PhotoRef | undefined> {
    for (const [k, p] of this.photos) if (p.publicToken === token) return { ownerId: k.slice(0, k.indexOf("#")), eventId: p.eventId, photoId: p.id };
    return undefined;
  }

  reviews = new Map<string, ReviewLink>(); // key: token
  async putReview(_u: string, link: ReviewLink) { this.reviews.set(link.token, clone(link)); }
  async listReviews(u: string) { return [...this.reviews.values()].filter((r) => r.ownerId === u).map((r) => clone(r)); }
  async deleteReview(u: string, token: string) { if (this.reviews.get(token)?.ownerId === u) this.reviews.delete(token); }
  async findReview(token: string) { const r = this.reviews.get(token); return r && clone(r); }

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
