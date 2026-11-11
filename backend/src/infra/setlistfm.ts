import type { Song } from "../domain/schemas.js";
import type { FoundSetlist, SetlistGateway } from "../domain/setlist.js";

type RawSong = { name?: string; info?: string; tape?: boolean; cover?: { name?: string } };
type RawSet = { name?: string; encore?: number; song?: RawSong[] };
type RawSetlist = {
  url?: string;
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
}
