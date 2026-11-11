import { describe, expect, it } from "vitest";
import { connectCalendar, friedman, repoKinds, setup as baseSetup, type RepoKind } from "./helpers.js";

for (const kind of repoKinds) suite(kind);

function suite(kind: RepoKind) {
const setup = () => baseSetup(kind);

describe(`events and venues [${kind}]`, () => {
  it("creates an event with a find-or-create venue and requires only title + date", async () => {
    const { svc, me } = (await setup());
    const a = await svc.createEvent(me, friedman);
    expect(a.created).toBe(true);
    expect(a.event.venue?.name).toBe("Tokio Marine Hall");
    const b = await svc.createEvent(me, { title: "Other", date: "2026-12-01", venue: { name: "tokio marine hall" } });
    expect(b.event.venueId).toBe(a.event.venueId); // same venue, case-insensitive
    expect((await svc.listVenues(me))).toHaveLength(1);
    const bare = await svc.createEvent(me, { title: "Bare", date: "2026-12-02" });
    expect(bare.event.venue).toBeNull();
  });

  it("bulk: creates, updates in place, reports unchanged and failed", async () => {
    const { svc, me } = await setup();
    await svc.createEvent(me, friedman);
    const r = await svc.bulkCreateEvents(me, [
      friedman, // identical: unchanged
      { ...friedman, doorsTime: "18:30", genre: "Metal" }, // same show with new data: updated
      { title: "New one", date: "2026-12-05" },
      { title: "Bad venue", date: "2026-12-06", venueId: "nope" },
    ]);
    expect(r.created.map((e) => e.title)).toEqual(["New one"]);
    expect(r.unchanged).toHaveLength(1);
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0]?.changedFields.sort()).toEqual(["doorsTime", "genre"]);
    expect(r.failed[0]?.error).toMatch(/not found/);
  });

  describe("duplicates are upserted", () => {
    it("same venue and date is the same show even with a different title; given fields win, omitted ones stay", async () => {
      const { svc, me } = await setup();
      const a = (await svc.createEvent(me, { ...friedman, notes: "my note", genre: "Metal" })).event;
      const r = await svc.createEvent(me, { title: "Marty Friedman - Drum Tour", date: friedman.date, venueId: a.venueId, startTime: "20:30", tiers: [{ name: "Pista", price: 320 }] });
      expect(r).toMatchObject({ created: false, updated: true, matchedBy: "venue_and_date", duplicateOf: a.id });
      expect(r.changedFields.sort()).toEqual(["startTime", "tiers", "title"]);
      expect(r.event.title).toBe("Marty Friedman - Drum Tour");
      expect(r.event.startTime).toBe("20:30");
      expect(r.event.doorsTime).toBe("19:00"); // omitted, kept
      expect(r.event.notes).toBe("my note");
      expect(r.event.lineup).toHaveLength(2);
      expect((await svc.listEvents(me)).total).toBe(1);
    });

    it("reports no change for a resubmission, and does not bump updatedAt", async () => {
      const { svc, me } = await setup();
      const a = (await svc.createEvent(me, friedman)).event;
      const r = await svc.createEvent(me, { ...friedman, title: "MARTY friedman" });
      expect(r).toMatchObject({ created: false, updated: false, changedFields: [] });
      expect(r.event.title).toBe("Marty Friedman"); // casing alone is not a change
      expect(r.event.updatedAt).toBe(a.updatedAt);
    });

    it("same title and date matches when a venue is unknown, and fills the venue in", async () => {
      const { svc, me } = await setup();
      const a = (await svc.createEvent(me, { title: "Angra", date: "2026-11-28" })).event;
      const r = await svc.createEvent(me, { title: "Angra", date: "2026-11-28", venue: { name: "Vibra" } });
      expect(r).toMatchObject({ updated: true, matchedBy: "title_and_date", duplicateOf: a.id });
      expect(r.event.venue?.name).toBe("Vibra");
      expect(r.changedFields).toEqual(["venueId"]);
    });

    it("a show that changes venue is moved, not duplicated, and the calendar location follows", async () => {
      const s = await setup();
      await connectCalendar(s);
      const a = (await s.svc.createEvent(s.me, { title: "Angra", date: "2026-11-28", startTime: "20:30", venue: { name: "Vibra", address: "Av. Nações Unidas 17955" } })).event;
      await s.svc.setRsvp(s.me, a.id, { status: "going" });
      const r = await s.svc.createEvent(s.me, { title: "Angra", date: "2026-11-28", venue: { name: "Cult Club", address: "Rua Augusta 1" } });
      expect(r).toMatchObject({ created: false, updated: true, matchedBy: "title_and_date_venue_changed", duplicateOf: a.id });
      expect(r.venueChanged).toMatchObject({ from: { name: "Vibra" }, to: { name: "Cult Club" } });
      expect(r.event.rsvp?.status).toBe("going");
      expect((await s.svc.listEvents(s.me)).total).toBe(1);
      expect([...s.calendar.events.values()][0]?.body.location).toContain("Cult Club");
      expect(s.calendar.events.size).toBe(1);
      // moving to an existing venue by id works too
      const vibra = (await s.svc.listVenues(s.me)).find((v) => v.name === "Vibra")!;
      const back = await s.svc.createEvent(s.me, { title: "angra", date: "2026-11-28", venueId: vibra.id });
      expect(back.venueChanged).toMatchObject({ from: { name: "Cult Club" }, to: { name: "Vibra" } });
    });

    it("does not treat a move as a duplicate when it is ambiguous, in the past, contradicts the lineup or has another title", async () => {
      const { svc, me } = await setup();
      // different title: a different show
      await svc.createEvent(me, { title: "Angra", date: "2026-11-28", venue: { name: "Vibra" } });
      expect((await svc.createEvent(me, { title: "Angra Tour 2026", date: "2026-11-28", venue: { name: "Cult Club" } })).created).toBe(true);
      // lineups that share no act: a different show
      await svc.createEvent(me, { title: "Jazz Night", date: "2026-12-05", venue: { name: "Blue Note" }, lineup: [{ name: "Trio A" }] });
      expect((await svc.createEvent(me, { title: "Jazz Night", date: "2026-12-05", venue: { name: "Bourbon St" }, lineup: [{ name: "Quartet B" }] })).created).toBe(true);
      // with a shared act it is the same show that moved
      expect((await svc.createEvent(me, { title: "Jazz Night", date: "2026-12-05", venue: { name: "Vibra" }, lineup: [{ name: "trio a" }, { name: "Guest" }] })).matchedBy).toBe("title_and_date_venue_changed");
      // past shows never move
      await svc.createEvent(me, { title: "Old Gig", date: "2025-05-01", venue: { name: "Vibra" } });
      expect((await svc.createEvent(me, { title: "Old Gig", date: "2025-05-01", venue: { name: "Cult Club" } })).created).toBe(true);
    });

    it("never moves a show twice in one batch: same title at two venues on one day stay two shows", async () => {
      const { svc, me } = await setup();
      const r = await svc.bulkCreateEvents(me, [
        { title: "Festival", date: "2026-11-28", venue: { name: "Vibra" } },
        { title: "Festival", date: "2026-11-28", venue: { name: "Cult Club" } },
      ]);
      expect(r.created).toHaveLength(2);
      expect(r.updated).toHaveLength(0);
      // with two candidates left over, a later single submission is ambiguous and creates a third rather than guessing
      const later = await svc.createEvent(me, { title: "Festival", date: "2026-11-28", venue: { name: "Bourbon St" } });
      expect(later.created).toBe(true);
    });

    it("bulk reports moved shows in updated[].venueChanged", async () => {
      const { svc, me } = await setup();
      await svc.createEvent(me, { title: "Angra", date: "2026-11-28", venue: { name: "Vibra" } });
      const r = await svc.bulkCreateEvents(me, [{ title: "Angra", date: "2026-11-28", venue: { name: "Cult Club" } }]);
      expect(r.updated[0]?.venueChanged).toMatchObject({ from: { name: "Vibra" }, to: { name: "Cult Club" } });
      expect(r.updated[0]?.changedFields).toEqual(["venueId"]);
    });

    it("ifDuplicate=skip leaves the stored event alone", async () => {
      const { svc, me } = await setup();
      await svc.createEvent(me, friedman);
      const r = await svc.createEvent(me, { ...friedman, startTime: "23:00" }, "skip");
      expect(r).toMatchObject({ created: false, updated: false });
      expect(r.event.startTime).toBe("21:00");
      // skip also leaves a show that would have moved where it is
      const moved = await svc.createEvent(me, { ...friedman, venue: { name: "Cult Club" } }, "skip");
      expect(moved).toMatchObject({ created: false, updated: false, matchedBy: "title_and_date_venue_changed" });
      expect(moved.event.venue?.name).toBe("Tokio Marine Hall");
    });

    it("pushes the change to the calendar entry of a show you are going to", async () => {
      const s = await setup();
      await connectCalendar(s);
      const { event } = await s.svc.createEvent(s.me, friedman);
      await s.svc.setRsvp(s.me, event.id, { status: "going" });
      const r = await s.svc.createEvent(s.me, { ...friedman, startTime: "20:00" });
      expect(r.updated).toBe(true);
      expect(r.calendar?.status).toBe("synced");
      expect([...s.calendar.events.values()][0]?.body.start).toMatchObject({ dateTime: "2026-11-11T20:00:00" });
      expect(s.calendar.events.size).toBe(1);
      expect(r.event.rsvp?.status).toBe("going"); // the RSVP survives
    });
  });

  describe("venue matching", () => {
    it("matches a shorter or longer name of the same venue instead of creating another", async () => {
      const { svc, me } = await setup();
      const club = await svc.createVenue(me, { name: "Fabrique Club", city: "São Paulo" });
      const r = await svc.createEvent(me, { title: "Show A", date: "2026-12-01", venue: { name: "Fabrique" } });
      expect(r.event.venueId).toBe(club.id);
      expect(r.venueNote).toMatchObject({ given: "Fabrique", matched: "Fabrique Club", id: club.id });
      expect(r.venueCreated).toBeUndefined();
      const r2 = await svc.createEvent(me, { title: "Show B", date: "2026-12-02", venue: { name: "fabrique club ", city: "São Paulo" } });
      expect(r2.event.venueId).toBe(club.id);
      expect(r2.venueNote).toBeUndefined(); // exact, nothing to flag
      const r3 = await svc.createEvent(me, { title: "Show C", date: "2026-12-03", venue: { name: "Blue Note" } });
      await svc.createEvent(me, { title: "Show D", date: "2026-12-04", venue: { name: "Blue Note SP" } });
      expect((await svc.listVenues(me)).map((v) => v.name).sort()).toEqual(["Blue Note", "Fabrique Club"]);
      expect(r3.venueCreated?.name).toBe("Blue Note");
    });

    it("does not merge different venues that only share a generic word, or the same name in another city", async () => {
      const { svc, me } = await setup();
      await svc.createVenue(me, { name: "Casa Natura Musical", city: "São Paulo" });
      await svc.createEvent(me, { title: "A", date: "2026-12-01", venue: { name: "Casa Rock" } });
      await svc.createVenue(me, { name: "Vibra", city: "São Paulo" });
      await svc.createEvent(me, { title: "B", date: "2026-12-02", venue: { name: "Vibra Rio", city: "Rio de Janeiro" } });
      const r = await svc.createEvent(me, { title: "C", date: "2026-12-03", venue: { name: "Vibra", city: "Rio de Janeiro" } });
      expect(r.venueCreated).toBeUndefined(); // exact name wins over city here
      expect((await svc.listVenues(me)).map((v) => v.name).sort()).toEqual(["Casa Natura Musical", "Casa Rock", "Vibra", "Vibra Rio"]);
    });

    it("asks for a venueId when a name fits several venues, and creates nothing", async () => {
      const { svc, me } = await setup();
      const a = await svc.createVenue(me, { name: "Teatro Bradesco Sao Paulo" });
      await svc.createVenue(me, { name: "Teatro Bradesco Rio" });
      const r = await svc.bulkCreateEvents(me, [{ title: "X", date: "2026-12-01", venue: { name: "Bradesco" } }, { title: "Y", date: "2026-12-01", venueId: a.id }]);
      expect(r.failed[0]?.error).toMatch(/could be .*Teatro Bradesco Rio.*Teatro Bradesco Sao Paulo.*Pass venueId/);
      expect(r.created.map((e) => e.title)).toEqual(["Y"]);
      expect((await svc.listVenues(me))).toHaveLength(2);
      expect((await svc.listEvents(me)).total).toBe(1);
    });

    it("bulk reports created venues and similar-name matches for review", async () => {
      const { svc, me } = await setup();
      await svc.createVenue(me, { name: "Fabrique Club" });
      const r = await svc.bulkCreateEvents(me, [
        { title: "A", date: "2026-12-01", venue: { name: "Fabrique" } },
        { title: "B", date: "2026-12-02", venue: { name: "Fabrique" } },
        { title: "C", date: "2026-12-03", venue: { name: "Brand New Hall" } },
      ]);
      expect(r.venuesMatchedBySimilarName).toEqual([{ given: "Fabrique", matched: "Fabrique Club", id: expect.any(String) }]);
      expect(r.venuesCreated.map((v) => v.name)).toEqual(["Brand New Hall"]);
    });

    it("creates a new venue only when it is needed: a duplicate at a known venue creates none", async () => {
      const { svc, me } = await setup();
      await svc.createEvent(me, { title: "Angra", date: "2026-11-28", venue: { name: "Vibra" } });
      const before = (await svc.listVenues(me)).length;
      await svc.createEvent(me, { title: "Angra", date: "2026-11-28", venue: { name: "Vibra" }, notes: "x" });
      expect((await svc.listVenues(me)).length).toBe(before);
      // a move to a brand-new venue creates that venue once, and leaves the old one (with no shows) in place
      const r = await svc.createEvent(me, { title: "Angra", date: "2026-11-28", venue: { name: "Totally Different Place" } });
      expect(r.venueChanged?.to.name).toBe("Totally Different Place");
      expect((await svc.listVenues(me)).map((v) => `${v.name}:${v.eventCount}`).sort()).toEqual(["Totally Different Place:1", "Vibra:0"]);
    });
  });

  it("filters: undecided, text over lineup, date range; sorted by date", async () => {
    const { svc, me } = (await setup());
    const a = await svc.createEvent(me, friedman);
    await svc.createEvent(me, { title: "Z show", date: "2026-10-01", lineup: [{ name: "Angra" }] });
    await svc.createEvent(me, { title: "A show", date: "2026-12-24" });
    await svc.setRsvp(me, a.event.id, { status: "interested" });
    expect((await svc.listEvents(me, { rsvp: "none" })).events.map((e) => e.title)).toEqual(["Z show", "A show"]);
    expect((await svc.listEvents(me, { text: "angra" })).events).toHaveLength(1);
    expect((await svc.listEvents(me, { upcoming: true })).events.map((e) => e.title)).toEqual(["Marty Friedman", "A show"]);
    expect((await svc.listEvents(me, { from: "2026-11-01", to: "2026-11-30" })).total).toBe(1);
  });

  it("updates fields, and null clears them", async () => {
    const { svc, me } = await setup();
    const { event } = await svc.createEvent(me, { ...friedman, genre: "metal", notes: "x" });
    const r = await svc.updateEvent(me, event.id, { genre: null, doorsTime: null, startTime: "20:00", venueId: null });
    expect(r.event.genre).toBeUndefined();
    expect(r.event.doorsTime).toBeUndefined();
    expect(r.event.startTime).toBe("20:00");
    expect(r.event.venue).toBeNull();
    expect(r.event.notes).toBe("x");
    await expect(svc.updateEvent(me, event.id, { title: null })).rejects.toThrow(/cannot be cleared/);
    const v = await svc.createVenue(me, { name: "V", city: "SP" });
    expect((await svc.updateVenue(me, v.id, { city: null, address: "Rua 1" }))).toMatchObject({ address: "Rua 1" });
  });

  it("refuses to delete a venue in use and merges duplicates", async () => {
    const { svc, me } = (await setup());
    const a = await svc.createEvent(me, friedman);
    const dup = await svc.createVenue(me, { name: "Tokio Marine Hall SP" });
    await expect(svc.deleteVenue(me, a.event.venueId!)).rejects.toThrow(/used by 1/);
    const r = await svc.mergeVenues(me, a.event.venueId!, dup.id);
    expect(r.moved).toBe(1);
    expect((await svc.getEvent(me, a.event.id)).venueId).toBe(dup.id);
  });

  it("retires a venue: hidden from list_venues, still on its events and in stats, reversible", async () => {
    const { svc, me } = await setup();
    const a = (await svc.createEvent(me, { title: "Old gig", date: "2025-05-01", venue: { name: "Closed Club" } })).event;
    await svc.createEvent(me, { title: "Other", date: "2026-12-01", venue: { name: "Open Club" } });
    await svc.setRsvp(me, a.id, { status: "attended" });
    const retired = await svc.retireVenue(me, a.venueId!);
    expect(retired.retiredAt).toBeTruthy();
    expect((await svc.listVenues(me)).map((v) => v.name)).toEqual(["Open Club"]);
    expect((await svc.listVenues(me, { includeRetired: true })).map((v) => v.name)).toEqual(["Closed Club", "Open Club"]);
    expect((await svc.listVenues(me, { text: "closed" }))).toHaveLength(0);
    expect((await svc.getEvent(me, a.id)).venue?.name).toBe("Closed Club");
    expect((await svc.stats(me)).attendedByVenue[0]).toMatchObject({ venue: "Closed Club", count: 1 });
    expect((await svc.retireVenue(me, a.venueId!)).retiredAt).toBe(retired.retiredAt); // idempotent
    // adding another event at the same name reuses the retired venue instead of resurrecting or duplicating it
    const again = await svc.createEvent(me, { title: "Late add", date: "2025-06-01", venue: { name: "closed club" } });
    expect(again.event.venueId).toBe(a.venueId);
    expect((await svc.listVenues(me)).map((v) => v.name)).toEqual(["Open Club"]);
    await expect(svc.createVenue(me, { name: "Closed Club" })).rejects.toThrow(/retired/);
    const open = (await svc.listVenues(me))[0]!;
    await expect(svc.mergeVenues(me, open.id, a.venueId!)).rejects.toThrow(/retired/);
    const back = await svc.unretireVenue(me, a.venueId!);
    expect(back.retiredAt).toBeUndefined();
    expect((await svc.listVenues(me)).map((v) => v.name)).toEqual(["Closed Club", "Open Club"]);
  });

  it("keeps data private per user", async () => {
    const { svc, me, her } = (await setup());
    const a = await svc.createEvent(me, friedman);
    await expect(svc.getEvent(her, a.event.id)).rejects.toThrow(/not found/);
    expect((await svc.listEvents(her)).total).toBe(0);
  });
});

describe(`RSVP [${kind}]`, () => {
  it("is one per event and validates the tier", async () => {
    const { svc, me } = (await setup());
    const { event } = await svc.createEvent(me, friedman);
    await svc.setRsvp(me, event.id, { status: "interested" });
    const r = await svc.setRsvp(me, event.id, { status: "going", tierName: "Pista", quantity: 2, pricePaid: 600, feesPaid: 90 });
    expect(r.rsvp.status).toBe("going");
    expect((await svc.listRsvps(me))).toHaveLength(1);
    await expect(svc.setRsvp(me, event.id, { status: "going", tierName: "VIP" })).rejects.toThrow(/Tiers: Pista, Camarote/);
  });

  it("warns on overlap but still saves", async () => {
    const { svc, me } = (await setup());
    const a = (await svc.createEvent(me, friedman)).event;
    const b = (await svc.createEvent(me, { title: "Same night", date: "2026-11-11", startTime: "22:00" })).event;
    const c = (await svc.createEvent(me, { title: "Next day", date: "2026-11-12", startTime: "21:00" })).event;
    expect((await svc.setRsvp(me, a.id, { status: "going" })).warnings).toEqual([]);
    const r = await svc.setRsvp(me, b.id, { status: "going" });
    expect(r.warnings[0]).toMatch(/Marty Friedman/);
    expect(r.rsvp.status).toBe("going");
    expect((await svc.setRsvp(me, c.id, { status: "going" })).warnings).toEqual([]);
  });

  it("removes the rsvp and returns the event to undecided", async () => {
    const { svc, me } = (await setup());
    const { event } = await svc.createEvent(me, friedman);
    await svc.setRsvp(me, event.id, { status: "going" });
    await svc.removeRsvp(me, event.id);
    expect((await svc.getEvent(me, event.id)).rsvp).toBeNull();
  });
});

describe(`sharing [${kind}]`, () => {
  it("shows a shared RSVP to the other user by email, and stops when unshared", async () => {
    const s = (await setup());
    const { svc, me, her } = s;
    await svc.ensureUser(her);
    const { event } = await svc.createEvent(me, friedman);
    await expect(svc.shareRsvp(me, event.id, ["Her@Example.com"])).rejects.toThrow(/RSVP first/);
    await svc.setRsvp(me, event.id, { status: "going" });
    await svc.shareRsvp(me, event.id, ["Her@Example.com", "me@example.com"]);
    const shared = await svc.listSharedWithMe(her);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.title).toBe("Marty Friedman");
    expect(shared[0]?.sharedBy.email).toBe("me@example.com");
    expect(shared[0]?.venue?.name).toBe("Tokio Marine Hall");
    expect((await svc.listSharedWithMe(me))).toHaveLength(0);
    await svc.unshareRsvp(me, event.id, ["her@example.com"]);
    expect(await svc.listSharedWithMe(her)).toHaveLength(0);
  });
});

describe(`stats [${kind}]`, () => {
  it("counts attended shows per venue and sums spend", async () => {
    const { svc, me } = (await setup());
    const a = (await svc.createEvent(me, { title: "A", date: "2025-05-01", venue: { name: "Vibra" } })).event;
    const b = (await svc.createEvent(me, { title: "B", date: "2026-01-01", venue: { name: "Vibra" } })).event;
    const c = (await svc.createEvent(me, { title: "C", date: "2026-02-01", venue: { name: "Cult" } })).event;
    await svc.setRsvp(me, a.id, { status: "attended", pricePaid: 200, feesPaid: 20 });
    await svc.setRsvp(me, b.id, { status: "attended", pricePaid: 100 });
    await svc.setRsvp(me, c.id, { status: "attended" });
    const st = await svc.stats(me);
    expect(st.attendedTotal).toBe(3);
    expect(st.attendedByVenue[0]).toMatchObject({ venue: "Vibra", count: 2 });
    expect(st.attendedByYear).toEqual({ "2025": 1, "2026": 2 });
    expect(st.totalSpent).toEqual({ BRL: 320 });
    expect((await svc.stats(me, { year: 2026 })).attendedTotal).toBe(2);
  });
});

describe(`going + past date = attended [${kind}]`, () => {
  it("counts only going shows whose date is over, and treats a stored or sent 'attended' as going", async () => {
    const { svc, me, repo } = (await setup());
    const past = (await svc.createEvent(me, { title: "Past going", date: "2026-10-01" })).event;
    const future = (await svc.createEvent(me, { title: "Future going", date: "2026-12-01" })).event;
    const missed = (await svc.createEvent(me, { title: "Missed", date: "2026-10-02" })).event;
    const interested = (await svc.createEvent(me, { title: "Maybe", date: "2026-10-03" })).event;
    const legacy = (await svc.createEvent(me, { title: "Legacy", date: "2026-10-04" })).event;
    await svc.setRsvp(me, past.id, { status: "going" });
    await svc.setRsvp(me, future.id, { status: "going" });
    await svc.setRsvp(me, missed.id, { status: "skipped" });
    await svc.setRsvp(me, interested.id, { status: "interested" });
    const sent = await svc.setRsvp(me, legacy.id, { status: "attended" });
    expect(sent.rsvp.status).toBe("going");

    const titles = async (rsvp: "attended" | "going") => (await svc.listEvents(me, { rsvp, sort: "asc" })).events.map((e) => e.title);
    expect(await titles("attended")).toEqual(["Past going", "Legacy"]);
    expect(await titles("going")).toEqual(["Future going"]);
    const st = await svc.stats(me);
    expect(st.attendedTotal).toBe(2);
    expect(st.upcomingGoing).toBe(1);

    // Old rows stored as "attended" read back as going, and still count.
    const old = (await svc.createEvent(me, { title: "Old row", date: "2025-01-01" })).event;
    await repo.putRsvp(me.userId, { eventId: old.id, status: "attended", sharedWith: [], createdAt: "", updatedAt: "" });
    const view = (await svc.getEvent(me, old.id));
    expect(view).toMatchObject({ past: true, attended: true, rsvp: { status: "going" } });
    expect((await svc.stats(me)).attendedTotal).toBe(3);
  });

  it("decides 'past' in the venue's own time zone", async () => {
    const { svc, me } = (await setup()); // clock: 2026-11-10 12:00 UTC = Nov 11 in Auckland, still Nov 10 in São Paulo
    const nz = (await svc.createEvent(me, { title: "Auckland", date: "2026-11-10", venue: { name: "Spark Arena", timezone: "Pacific/Auckland" } })).event;
    const sp = (await svc.createEvent(me, { title: "São Paulo", date: "2026-11-10", venue: { name: "Vibra", timezone: "America/Sao_Paulo" } })).event;
    await svc.setRsvp(me, nz.id, { status: "going" });
    await svc.setRsvp(me, sp.id, { status: "going" });
    expect((await svc.getEvent(me, nz.id)).attended).toBe(true);
    expect((await svc.getEvent(me, sp.id)).attended).toBe(false);
    expect((await svc.getEvent(me, sp.id)).past).toBe(false);
  });
});

describe(`calendar sync [${kind}]`, () => {
  it("does nothing until connected, and the RSVP still saves", async () => {
    const { svc, me, calendar } = (await setup());
    const { event } = await svc.createEvent(me, friedman);
    const r = await svc.setRsvp(me, event.id, { status: "going" });
    expect(r.calendar.status).toBe("skipped");
    expect(calendar.events.size).toBe(0);
  });

  it("creates a native-location entry with doors, 1-day reminder, then updates and removes it", async () => {
    const s = (await setup());
    const { svc, me, calendar } = s;
    await connectCalendar(s);
    const { event } = await svc.createEvent(me, friedman);
    const r = await svc.setRsvp(me, event.id, { status: "going", tierName: "Pista", quantity: 2, pricePaid: 600, feesPaid: 90, companions: ["Her"] });
    expect(r.calendar.status).toBe("synced");
    const [entry] = [...calendar.events.values()];
    expect(entry?.calendarId).toBe("shared");
    expect(entry?.body.summary).toBe("Marty Friedman");
    expect(entry?.body.location).toBe("Tokio Marine Hall, R. Bragança Paulista, 1281 - Chácara Santo Antônio, São Paulo - SP");
    expect(entry?.body.start).toEqual({ dateTime: "2026-11-11T21:00:00", timeZone: "America/Sao_Paulo" });
    expect(entry?.body.end).toEqual({ dateTime: "2026-11-12T00:00:00", timeZone: "America/Sao_Paulo" });
    expect(entry?.body.description).toContain("Doors: 19:00");
    expect(entry?.body.description).toContain("Opener Band (opener)");
    expect(entry?.body.description).toContain("Paid: BRL 600.00 + fees BRL 90.00");
    expect(entry?.body.reminders.overrides).toEqual([{ method: "popup", minutes: 1440 }]);

    // editing the event updates the same calendar entry
    await svc.updateEvent(me, event.id, { startTime: "20:30" });
    expect(calendar.events.size).toBe(1);
    expect([...calendar.events.values()][0]?.body.start).toMatchObject({ dateTime: "2026-11-11T20:30:00" });

    // interested/skipped removes it; going again re-adds
    await svc.setRsvp(me, event.id, { status: "skipped" });
    expect(calendar.events.size).toBe(0);
    await svc.setRsvp(me, event.id, { status: "going" });
    expect(calendar.events.size).toBe(1);

    // removing the RSVP / deleting the event removes the entry
    await svc.removeRsvp(me, event.id);
    expect(calendar.events.size).toBe(0);
    await svc.setRsvp(me, event.id, { status: "going" });
    await svc.deleteEvent(me, event.id);
    expect(calendar.events.size).toBe(0);
  });

  it("uses an all-day entry when no time is known", async () => {
    const s = (await setup());
    await connectCalendar(s);
    const { event } = await s.svc.createEvent(s.me, { title: "TBA", date: "2026-12-31" });
    await s.svc.setRsvp(s.me, event.id, { status: "going" });
    const [entry] = [...s.calendar.events.values()];
    expect(entry?.body.start).toEqual({ date: "2026-12-31" });
    expect(entry?.body.end).toEqual({ date: "2027-01-01" });
  });

  it("saves the RSVP even when Google fails, and resync recovers", async () => {
    const s = (await setup());
    await connectCalendar(s);
    const { event } = await s.svc.createEvent(s.me, friedman);
    s.calendar.fail = true;
    const r = await s.svc.setRsvp(s.me, event.id, { status: "going" });
    expect(r.rsvp.status).toBe("going");
    expect(r.calendar).toMatchObject({ status: "error", message: "google down" });
    s.calendar.fail = false;
    expect((await s.svc.resyncAll(s.me)).synced).toBe(1);
    expect(s.calendar.events.size).toBe(1);
  });

  it("moves entries when another calendar is selected, and can create a dedicated one", async () => {
    const s = (await setup());
    await connectCalendar(s);
    const { event } = await s.svc.createEvent(s.me, friedman);
    await s.svc.setRsvp(s.me, event.id, { status: "going" });
    const sel = await s.svc.calendarSelect(s.me, { createName: "Concerts (new)" });
    expect(sel.resync.synced).toBe(1);
    expect(s.calendar.events.size).toBe(1);
    expect([...s.calendar.events.values()][0]?.calendarId).toBe(sel.calendarId);
  });

  it("rejects a stale or reused connect state", async () => {
    const s = (await setup());
    await s.svc.ensureUser(s.me);
    const { url } = await s.svc.calendarConnectUrl(s.me);
    const state = new URL(url).searchParams.get("state")!;
    await s.svc.completeCalendarConnect(state, "t");
    await expect(s.svc.completeCalendarConnect(state, "t")).rejects.toThrow(/expired/);
  });

  it("disconnect optionally removes entries", async () => {
    const s = (await setup());
    await connectCalendar(s);
    const { event } = await s.svc.createEvent(s.me, friedman);
    await s.svc.setRsvp(s.me, event.id, { status: "going" });
    await s.svc.calendarDisconnect(s.me, { removeEvents: true });
    expect(s.calendar.events.size).toBe(0);
    expect((await s.svc.calendarStatus(s.me)).connected).toBe(false);
  });
});

}
