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

/** Same name, ignoring case, accents, punctuation and a leading "The". Never a partial match: "Justice for the Damned" is not "The Damned". */
const sameName = (a: string, b: string) => { const strip = (x: string) => norm(x).replace(/^the /, ""); return !!strip(a) && strip(a) === strip(b); };
const artistMatches = (given: string, found?: string) => !!found && sameName(given, found);

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
  private static MIN_GAP_MS = 700;
  /** After a 429 (rate limit) wait and try again this many times, for at most MAX_WAIT_MS each. */
  private static RETRIES = 3;
  private static MAX_WAIT_MS = 4000;
  constructor(private apiKey: string, private fetchFn: typeof fetch = fetch, private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}

  private async throttle() {
    const wait = this.last + SetlistFmGateway.MIN_GAP_MS - Date.now();
    this.last = Date.now() + Math.max(0, wait);
    if (wait > 0) await this.sleep(wait);
  }

  /** One throttled GET. A 429 is retried after its Retry-After (or 1 s, 2 s, 4 s), so a busy moment does not fail the lookup. */
  private async get(path: string, params: Record<string, string>): Promise<Response> {
    const url = `https://api.setlist.fm/rest/1.0/${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.fetchFn(url, { headers: { "x-api-key": this.apiKey, accept: "application/json", "accept-language": "en" } });
      if (res.status !== 429 || attempt >= SetlistFmGateway.RETRIES) return res;
      const asked = Number(res.headers?.get("retry-after"));
      await this.sleep(Math.min(SetlistFmGateway.MAX_WAIT_MS, Number.isFinite(asked) && asked > 0 ? asked * 1000 : 1000 * 2 ** attempt));
    }
  }

  async find({ artist, date, city }: { artist: string; date: string; city?: string }) {
    const [y, m, d] = date.split("-");
    const res = await this.get("search/setlists", { artistName: artist, date: `${d}-${m}-${y}`, p: "1" });
    if (res.status === 404) return undefined; // setlist.fm answers 404 when nothing matches
    if (!res.ok) throw new Error(`setlist.fm answered ${res.status}`);
    const body = (await res.json()) as { setlist?: RawSetlist[] };
    return pickSetlist(body.setlist ?? [], artist, city);
  }

  /** The artist whose name is exactly `name`, best match first. A fuzzy search would also return bands that merely contain it. */
  private async artistId(name: string): Promise<string | undefined> {
    const res = await this.get("search/artists", { artistName: name, sort: "relevance", p: "1" });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`setlist.fm answered ${res.status}`);
    const body = (await res.json()) as { artist?: Array<{ mbid?: string; name?: string }> };
    return (body.artist ?? []).find((a) => a.mbid && a.name && sameName(name, a.name))?.mbid;
  }

  async recent({ artist, limit, before }: { artist: string; limit: number; before?: string }) {
    const mbid = await this.artistId(artist);
    if (!mbid) return [];
    // One page is 20 setlists, newest first. Many of them are empty drafts, so this can return fewer than `limit`.
    const res = await this.get(`artist/${encodeURIComponent(mbid)}/setlists`, { p: "1" });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`setlist.fm answered ${res.status}`);
    const body = (await res.json()) as { setlist?: RawSetlist[] };
    return pickRecent(body.setlist ?? [], artist, limit, before);
  }
}
