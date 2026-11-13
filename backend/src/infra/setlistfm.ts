import type { Song } from "../domain/schemas.js";
import type { FoundSetlist, RecentSetlist, SetlistGateway } from "../domain/setlist.js";

type RawSong = { name?: string; info?: string; tape?: boolean; cover?: { name?: string } };
type RawSet = { name?: string; encore?: number; song?: RawSong[] };
type RawSetlist = {
  url?: string;
  eventDate?: string; // dd-MM-yyyy
  artist?: { name?: string };
  venue?: { name?: string; city?: { name?: string } };
  sets?: { set?: RawSet[] };
};

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Flatten setlist.fm sets/encores into one ordered list; non-main sets keep their label in `section`. */
export function songsOf(raw: RawSetlist): Song[] {
  const out: Song[] = [];
  for (const set of raw.sets?.set ?? []) {
    const section = set.encore ? (set.encore > 1 ? `Encore ${set.encore}` : "Encore") : set.name || undefined;
    for (const s of set.song ?? []) {
      if (!s.name?.trim()) continue; // setlist.fm uses empty names for unknown slots
      out.push({
        name: s.name.trim(),
        ...(s.cover?.name ? { cover: s.cover.name } : {}),
        ...(s.info ? { info: s.info } : {}),
        ...(s.tape ? { tape: true } : {}),
        ...(section ? { section } : {}),
      });
    }
  }
  return out;
}

const artistMatches = (given: string, found?: string) => {
  if (!found) return false;
  const a = norm(given), b = norm(found);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};

/** Pick the right setlist from the day's candidates: right artist, with songs, preferring the show's city. */
export function pickSetlist(candidates: RawSetlist[], artist: string, city?: string): FoundSetlist | undefined {
  const usable = candidates.filter((c) => artistMatches(artist, c.artist?.name) && songsOf(c).length > 0);
  if (!usable.length) return undefined;
  const byCity = city ? usable.filter((c) => c.venue?.city?.name && norm(c.venue.city.name) === norm(city)) : [];
  const chosen = byCity[0] ?? (usable.length === 1 ? usable[0] : undefined);
  // Several tours' shows on one day in other cities: do not guess.
  if (!chosen) return undefined;
  return { artist: chosen.artist!.name!, songs: songsOf(chosen), url: chosen.url };
}

/** setlist.fm dates are dd-MM-yyyy. */
const isoDate = (d?: string) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d ?? ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined; };

/** The artist's own setlists with songs, newest first. The search is fuzzy, so other artists' results are dropped. */
export function pickRecent(candidates: RawSetlist[], artist: string, limit: number, before?: string): RecentSetlist[] {
  return candidates
    .map((c) => ({ c, date: isoDate(c.eventDate) }))
    .filter((x): x is { c: RawSetlist; date: string } => !!x.date && (!before || x.date < before) && artistMatches(artist, x.c.artist?.name) && songsOf(x.c).length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map(({ c, date }) => ({
      artist: c.artist!.name!, date, songs: songsOf(c), url: c.url,
      ...(c.venue?.name ? { venue: c.venue.name } : {}), ...(c.venue?.city?.name ? { city: c.venue.city.name } : {}),
    }));
}

export class SetlistFmGateway implements SetlistGateway {
  private last = 0;
  /** setlist.fm allows about 2 requests per second on a free key; stay under it. */
  private static MIN_GAP_MS = 600;
  constructor(private apiKey: string, private fetchFn: typeof fetch = fetch, private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}

  private async throttle() {
    const wait = this.last + SetlistFmGateway.MIN_GAP_MS - Date.now();
    this.last = Date.now() + Math.max(0, wait);
    if (wait > 0) await this.sleep(wait);
  }

  async find({ artist, date, city }: { artist: string; date: string; city?: string }) {
    await this.throttle();
    const [y, m, d] = date.split("-");
    const url = `https://api.setlist.fm/rest/1.0/search/setlists?${new URLSearchParams({ artistName: artist, date: `${d}-${m}-${y}`, p: "1" })}`;
    const res = await this.fetchFn(url, { headers: { "x-api-key": this.apiKey, accept: "application/json", "accept-language": "en" } });
    if (res.status === 404) return undefined; // setlist.fm answers 404 when nothing matches
    if (!res.ok) throw new Error(`setlist.fm answered ${res.status}`);
    const body = (await res.json()) as { setlist?: RawSetlist[] };
    return pickSetlist(body.setlist ?? [], artist, city);
  }

  async recent({ artist, limit, before }: { artist: string; limit: number; before?: string }) {
    await this.throttle();
    // One page is 20 setlists, newest first. Many of them are empty drafts, so this can return fewer than `limit`.
    const url = `https://api.setlist.fm/rest/1.0/search/setlists?${new URLSearchParams({ artistName: artist, p: "1" })}`;
    const res = await this.fetchFn(url, { headers: { "x-api-key": this.apiKey, accept: "application/json", "accept-language": "en" } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`setlist.fm answered ${res.status}`);
    const body = (await res.json()) as { setlist?: RawSetlist[] };
    return pickRecent(body.setlist ?? [], artist, limit, before);
  }
}
