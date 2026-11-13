import { describe, expect, it } from "vitest";
import { Service } from "../src/domain/service.js";
import type { FoundSetlist, RecentSetlist, SetlistGateway } from "../src/domain/setlist.js";
import { PlainEncryptor } from "../src/infra/crypto.js";
import { SetlistFmGateway, pickRecent, pickSetlist, songsOf } from "../src/infra/setlistfm.js";
import { FakeCalendar, friedman, setup } from "./helpers.js";

class FakeSetlists implements SetlistGateway {
  calls: Array<{ artist: string; date: string; city?: string }> = [];
  data = new Map<string, FoundSetlist>();
  recents = new Map<string, RecentSetlist[]>();
  recentCalls: Array<{ artist: string; limit: number; before?: string }> = [];
  fail = false;
  async recent(q: { artist: string; limit: number; before?: string }) {
    this.recentCalls.push(q);
    if (this.fail) throw new Error("setlist.fm answered 429");
    return this.recents.get(q.artist) ?? [];
  }
  async find(q: { artist: string; date: string; city?: string }) {
    this.calls.push(q);
    if (this.fail) throw new Error("setlist.fm answered 429");
    return this.data.get(q.artist);
  }
}

async function withSetlists() {
  const s = await setup();
  const gw = new FakeSetlists();
  const svc = new Service({ repo: s.repo, calendar: new FakeCalendar(), encryptor: new PlainEncryptor(), setlists: gw, now: () => new Date("2026-11-12T12:00:00Z") });
  return { ...s, svc, gw };
}
const marty: FoundSetlist = { artist: "Marty Friedman", url: "https://www.setlist.fm/setlist/x", songs: [{ name: "Tokyo Jukebox" }, { name: "Encore Song", section: "Encore" }] };

describe("setlists", () => {
  it("fetches one setlist per act of a past show and stores it", async () => {
    const { svc, me, gw } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    gw.data.set("Marty Friedman", marty);
    const r = await svc.syncSetlists(me, event.id);
    expect(r.results).toEqual([{ act: "Marty Friedman", status: "found", songs: 2 }, { act: "Opener Band", status: "not_found" }]);
    expect(r.event.setlists).toMatchObject([{ act: "Marty Friedman", source: "setlist.fm", url: marty.url }]);
    expect(gw.calls[0]).toEqual({ artist: "Marty Friedman", date: "2026-11-11", city: "São Paulo" });
    expect((await svc.getEvent(me, event.id)).setlists).toHaveLength(1);
  });

  it("refuses a show that has not happened yet", async () => {
    const { svc, me } = await withSetlists();
    const { event } = await svc.createEvent(me, { ...friedman, date: "2026-11-20" });
    await expect(svc.syncSetlists(me, event.id)).rejects.toThrow(/not happened/);
  });

  it("keeps manual setlists unless forced, and keeps stored data when a lookup finds nothing", async () => {
    const { svc, me, gw } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    await svc.setSetlist(me, event.id, { act: "Marty Friedman", songs: [{ name: "By hand" }] });
    gw.data.set("Marty Friedman", marty);
    expect((await svc.syncSetlists(me, event.id)).results[0]).toMatchObject({ status: "kept_manual" });
    expect(gw.calls).toHaveLength(1); // only the opener was looked up
    const forced = await svc.syncSetlists(me, event.id, { force: true });
    expect(forced.event.setlists?.[0]).toMatchObject({ source: "setlist.fm" });
    gw.data.clear();
    const again = await svc.syncSetlists(me, event.id);
    expect(again.event.setlists).toHaveLength(1); // not found does not wipe it
  });

  it("reports a failing lookup per act instead of failing the whole sync", async () => {
    const { svc, me, gw } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    gw.fail = true;
    const r = await svc.syncSetlists(me, event.id);
    expect(r.results.every((x) => x.status === "error")).toBe(true);
  });

  it("set_setlist with no songs removes the act's setlist", async () => {
    const { svc, me } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    await svc.setSetlist(me, event.id, { act: "Opener Band", songs: [{ name: "A" }] });
    expect((await svc.setSetlist(me, event.id, { act: "opener band", songs: [] })).setlists).toBeUndefined();
  });

  it("explains itself when no API key is configured", async () => {
    const { svc, me } = await setup(); // no gateway
    const { event } = await svc.createEvent(me, friedman);
    await expect(svc.syncSetlists(me, event.id)).rejects.toThrow(/API key/);
  });

  it("sweep: only recent shows I went to, only acts still missing a setlist, across all users", async () => {
    const { svc, me, her, gw } = await withSetlists();
    gw.data.set("Marty Friedman", marty);
    const going = (await svc.createEvent(me, friedman)).event;
    await svc.setRsvp(me, going.id, { status: "attended" });
    const undecided = (await svc.createEvent(me, { title: "Undecided", date: "2026-11-10", lineup: [{ name: "Marty Friedman" }] })).event;
    const old = (await svc.createEvent(me, { title: "Old", date: "2026-01-10", lineup: [{ name: "Marty Friedman" }] })).event;
    await svc.setRsvp(me, old.id, { status: "attended" });
    const hers = (await svc.createEvent(her, { title: "Hers", date: "2026-11-09", lineup: [{ name: "Marty Friedman" }] })).event;
    await svc.setRsvp(her, hers.id, { status: "going" });
    await svc.ensureUser(me); await svc.ensureUser(her);

    const sum = await svc.syncRecentSetlists();
    expect(sum).toMatchObject({ users: 2, checked: 2, found: 2, errors: 0 });
    expect((await svc.getEvent(me, undecided.id)).setlists).toBeUndefined();
    expect((await svc.getEvent(me, old.id)).setlists).toBeUndefined();
    expect((await svc.getEvent(her, hers.id)).setlists).toHaveLength(1);

    // Opener still has none, so the show is retried tomorrow; a fully covered show is not.
    gw.calls.length = 0;
    await svc.syncRecentSetlists();
    expect(gw.calls.map((c) => c.artist)).toEqual(["Marty Friedman", "Opener Band"]);
  });
});

describe("playlists", () => {
  const shows: RecentSetlist[] = [{ artist: "Marty Friedman", date: "2026-10-01", city: "Tokyo", songs: [{ name: "A" }] }];

  it("returns recent setlists per act without storing them", async () => {
    const { svc, me, gw } = await withSetlists();
    const { event } = await svc.createEvent(me, { ...friedman, date: "2026-11-20" });
    gw.recents.set("Marty Friedman", shows);
    const r = await svc.recentSetlists(me, event.id, { limit: 3 });
    expect(r.acts).toMatchObject([{ act: "Marty Friedman", status: "found", setlists: shows }, { act: "Opener Band", status: "none", setlists: [] }]);
    expect(gw.recentCalls[0]).toEqual({ artist: "Marty Friedman", limit: 3, before: "2026-11-20" });
    expect((await svc.getEvent(me, event.id)).setlists).toBeUndefined();
  });

  it("caps the limit, defaults to 5 and reports a failing act instead of failing the call", async () => {
    const { svc, me, gw } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    await svc.recentSetlists(me, event.id);
    await svc.recentSetlists(me, event.id, { limit: 99 });
    expect(gw.recentCalls.map((c) => c.limit)).toEqual([5, 5, 10, 10]);
    gw.fail = true;
    expect((await svc.recentSetlists(me, event.id)).acts.every((a) => a.status === "error")).toBe(true);
  });

  it("explains itself when no API key is configured", async () => {
    const { svc, me } = await setup();
    const { event } = await svc.createEvent(me, friedman);
    await expect(svc.recentSetlists(me, event.id)).rejects.toThrow(/API key/);
  });

  it("stores one playlist per act and service, replaces it, keeps lineup order and removes with url null", async () => {
    const { svc, me } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    await svc.setPlaylist(me, event.id, { act: "opener band", service: "Spotify", url: "https://open.spotify.com/playlist/1", title: "Opener" });
    await svc.setPlaylist(me, event.id, { act: "Marty Friedman", service: "spotify", url: "https://open.spotify.com/playlist/2", trackCount: 20 });
    await svc.setPlaylist(me, event.id, { act: "Marty Friedman", service: "applemusic", url: "https://music.apple.com/pl/3" });
    let v = await svc.setPlaylist(me, event.id, { act: "MARTY FRIEDMAN", service: "spotify", url: "https://open.spotify.com/playlist/4" });
    expect(v.playlists?.map((p) => [p.act, p.service, p.url.slice(-1)])).toEqual([
      ["Marty Friedman", "applemusic", "3"], ["MARTY FRIEDMAN", "spotify", "4"], ["opener band", "spotify", "1"],
    ]);
    v = await svc.setPlaylist(me, event.id, { act: "Marty Friedman", service: "spotify", url: null });
    expect(v.playlists).toHaveLength(2);
    await svc.setPlaylist(me, event.id, { act: "Marty Friedman", service: "applemusic", url: null });
    v = await svc.setPlaylist(me, event.id, { act: "Opener Band", service: "spotify", url: null });
    expect(v.playlists).toBeUndefined();
  });

  it("keeps playlists when the event is edited", async () => {
    const { svc, me } = await withSetlists();
    const { event } = await svc.createEvent(me, friedman);
    await svc.setPlaylist(me, event.id, { act: "Marty Friedman", service: "spotify", url: "https://open.spotify.com/playlist/1" });
    const { event: after } = await svc.updateEvent(me, event.id, { notes: "x" });
    expect(after.playlists).toHaveLength(1);
  });

  it("picks the artist's newest setlists with songs, before the show, dropping other artists", () => {
    const r = (artist: string, eventDate: string, songs: string[]) => ({ artist: { name: artist }, eventDate, venue: { name: "V", city: { name: "C" } }, sets: { set: [{ song: songs.map((name) => ({ name })) }] } });
    const list = [r("Marty Friedman", "01-10-2026", ["A"]), r("Marty Friedman", "20-11-2026", ["Z"]), r("Marty Friedman", "05-10-2026", []), r("Other", "02-10-2026", ["B"]), r("Marty Friedman", "20-09-2026", ["C"])];
    expect(pickRecent(list, "Marty Friedman", 5, "2026-11-20").map((x) => [x.date, x.songs[0]!.name])).toEqual([["2026-10-01", "A"], ["2026-09-20", "C"]]);
    expect(pickRecent(list, "Marty Friedman", 1)).toHaveLength(1);
  });

  it("gateway resolves the exact artist first, then reads that artist's setlists (not a fuzzy name search)", async () => {
    const seen: string[] = [];
    const sl = { artist: { name: "The Damned" }, eventDate: "01-10-2026", sets: { set: [{ song: [{ name: "A" }] }] } };
    const responses = [
      new Response(JSON.stringify({ artist: [{ mbid: "wrong", name: "Justice for the Damned" }, { mbid: "m1", name: "The Damned" }] })),
      new Response(JSON.stringify({ setlist: [sl, { ...sl, artist: { name: "Justice for the Damned" } }] })),
      new Response("{}", { status: 404 }),
    ];
    const fetchFn = (async (url: string) => { seen.push(url); return responses.shift()!; }) as unknown as typeof fetch;
    const gw = new SetlistFmGateway("k", fetchFn, async () => {});
    const r = await gw.recent({ artist: "The Damned", limit: 5 });
    expect(r.map((x) => x.artist)).toEqual(["The Damned"]);
    expect(new URL(seen[1]!).pathname).toBe("/rest/1.0/artist/m1/setlists");
    expect(await gw.recent({ artist: "Nobody", limit: 5 })).toEqual([]);
  });

  it("gateway returns nothing when no artist has exactly that name", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ artist: [{ mbid: "x", name: "Justice for the Damned" }] }))) as unknown as typeof fetch;
    expect(await new SetlistFmGateway("k", fetchFn, async () => {}).recent({ artist: "The Damned", limit: 5 })).toEqual([]);
  });

  it("matches names exactly: ignores case, accents and a leading The, never a part of a longer name", () => {
    const r = (artist: string, eventDate: string) => ({ artist: { name: artist }, eventDate, sets: { set: [{ song: [{ name: "A" }] }] } });
    const list = [r("Justice for the Damned", "13-11-2026"), r("Damned", "01-10-2026"), r("The Damned", "02-10-2026")];
    expect(pickRecent(list, "The Damned", 5).map((x) => x.date)).toEqual(["2026-10-02", "2026-10-01"]);
    expect(pickSetlist([r("Justice for the Damned", "13-11-2026") as never], "The Damned")).toBeUndefined();
  });

  it("retries a 429 after Retry-After, then succeeds; gives up after a few tries", async () => {
    const waits: number[] = [];
    const ok = () => new Response(JSON.stringify({ setlist: [] }));
    const seq = [new Response("", { status: 429, headers: { "retry-after": "2" } }), new Response("", { status: 429 }), ok()];
    const gw = new SetlistFmGateway("k", (async () => seq.shift()!) as unknown as typeof fetch, async (ms) => { waits.push(ms); });
    expect(await gw.find({ artist: "X", date: "2026-11-11" })).toBeUndefined();
    expect(waits.filter((w) => w >= 1500)).toEqual([2000, 2000]); // Retry-After 2 s, then no header: 1 s * 2 = 2 s
    let calls = 0;
    const always = new SetlistFmGateway("k", (async () => { calls++; return new Response("", { status: 429 }); }) as unknown as typeof fetch, async () => {});
    await expect(always.find({ artist: "X", date: "2026-11-11" })).rejects.toThrow(/429/);
    expect(calls).toBe(4);
  });
});

describe("setlist.fm gateway", () => {
  const raw = (artist: string, city: string, songs: string[]) => ({
    url: `https://www.setlist.fm/${artist}-${city}`, artist: { name: artist }, venue: { city: { name: city } },
    sets: { set: [{ song: songs.map((name) => ({ name })) }, { encore: 1, song: [{ name: "Bis", cover: { name: "Someone" }, tape: true }] }] },
  });

  it("flattens sets and encores, dropping unnamed slots", () => {
    expect(songsOf({ sets: { set: [{ song: [{ name: "A" }, { name: "" }] }, { encore: 2, song: [{ name: "B", info: "acoustic" }] }] } }))
      .toEqual([{ name: "A" }, { name: "B", info: "acoustic", section: "Encore 2" }]);
  });

  it("matches the artist loosely and prefers the show's city; refuses to guess between other cities", () => {
    const list = [raw("Marty Friedman", "Curitiba", ["X"]), raw("Marty Friedman", "São Paulo", ["Y"])];
    expect(pickSetlist(list, "marty friedman", "Sao Paulo")?.songs[0]?.name).toBe("Y");
    expect(pickSetlist(list, "Marty Friedman", "Recife")).toBeUndefined();
    expect(pickSetlist([raw("Other", "São Paulo", ["Z"])], "Marty Friedman", "São Paulo")).toBeUndefined();
    expect(pickSetlist([raw("Marty Friedman", "Recife", ["Z"])], "Marty Friedman", "São Paulo")?.songs).toHaveLength(2);
  });

  it("calls the API with the key and a dd-MM-yyyy date, and treats 404 as no setlist", async () => {
    const seen: Array<{ url: string; key: string }> = [];
    const responses = [new Response(JSON.stringify({ setlist: [raw("Marty Friedman", "São Paulo", ["Y"])] })), new Response("{}", { status: 404 }), ...Array.from({ length: 4 }, () => new Response("", { status: 429 }))];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, key: (init.headers as Record<string, string>)["x-api-key"]! });
      return responses.shift()!;
    }) as unknown as typeof fetch;
    const gw = new SetlistFmGateway("k", fetchFn, async () => {});
    expect((await gw.find({ artist: "Marty Friedman", date: "2026-11-11", city: "São Paulo" }))?.songs[0]?.name).toBe("Y");
    expect(seen[0]).toMatchObject({ key: "k" });
    expect(new URL(seen[0]!.url).searchParams.get("date")).toBe("11-11-2026");
    expect(await gw.find({ artist: "Nobody", date: "2026-11-11" })).toBeUndefined();
    await expect(gw.find({ artist: "X", date: "2026-11-11" })).rejects.toThrow(/429/);
  });
});
