import type { Song } from "./schemas.js";

export type FoundSetlist = { artist: string; songs: Song[]; url?: string };

/** Looks up what an act played on a given day. Returns undefined when nothing usable is published. */
export interface SetlistGateway {
  find(q: { artist: string; date: string; city?: string }): Promise<FoundSetlist | undefined>;
}
