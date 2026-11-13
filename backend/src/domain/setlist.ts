import type { Song } from "./schemas.js";

export type FoundSetlist = { artist: string; songs: Song[]; url?: string };

/** Looks up what an act played on a given day. Returns undefined when nothing usable is published. */
export interface SetlistGateway {
  find(q: { artist: string; date: string; city?: string }): Promise<FoundSetlist | undefined>;
  /** The artist's most recent setlists with songs, newest first, only from before `before` (yyyy-mm-dd) when given. */
  recent(q: { artist: string; limit: number; before?: string }): Promise<RecentSetlist[]>;
}

/** One show an artist played recently, as published on setlist.fm. */
export type RecentSetlist = FoundSetlist & { date: string; venue?: string; city?: string };
