// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";

const op = vi.fn();
vi.mock("../api", () => ({ op: (...a: unknown[]) => op(...a) }));
const { SetlistSection, songGroups, summarize } = await import("./SetlistSection");

const base: EventView = { id: "1", title: "Slayer", date: "2020-01-01", createdAt: "", updatedAt: "", venue: null, rsvp: null };
afterEach(() => { cleanup(); op.mockReset(); });

describe("SetlistSection", () => {
  it("numbers songs across encores", () => {
    expect(songGroups([{ name: "A" }, { name: "B" }, { name: "C", section: "Encore" }]).map((g) => [g.section, g.start, g.songs.length]))
      .toEqual([[undefined, 1, 2], ["Encore", 3, 1]]);
  });

  it("renders a stored setlist with covers and a setlist.fm link", () => {
    const e = { ...base, setlists: [{ act: "Slayer", source: "setlist.fm" as const, url: "https://www.setlist.fm/x", fetchedAt: "", songs: [{ name: "Raining Blood" }, { name: "Gimme Shelter", cover: "The Stones", section: "Encore" }] }] };
    render(<SetlistSection event={e} readOnly onUpdated={() => {}} />);
    expect(screen.getByText("Raining Blood")).toBeTruthy();
    expect(screen.getByText("(The Stones cover)")).toBeTruthy();
    expect(screen.getByText("Encore")).toBeTruthy();
    expect(screen.getByRole("link", { name: "setlist.fm" }).getAttribute("href")).toBe("https://www.setlist.fm/x");
    expect(screen.queryByRole("button")).toBeNull(); // shared view cannot sync
  });

  it("offers the sync button only for past shows", () => {
    render(<SetlistSection event={{ ...base, date: "2999-01-01" }} onUpdated={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    render(<SetlistSection event={base} onUpdated={() => {}} />);
    expect(screen.getByRole("button", { name: "Fetch setlist from setlist.fm" })).toBeTruthy();
  });

  it("syncs, shows the updated event and tells what happened", async () => {
    const updated = { ...base, setlists: [{ act: "Slayer", source: "setlist.fm" as const, fetchedAt: "", songs: [{ name: "Angel of Death" }] }] };
    op.mockResolvedValue({ event: updated, results: [{ act: "Slayer", status: "found", songs: 1 }] });
    const onUpdated = vi.fn();
    render(<SetlistSection event={base} onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
    expect(op).toHaveBeenCalledWith("sync_setlist", { eventId: "1" });
    expect((await screen.findByRole("status")).textContent).toMatch(/Found setlist for Slayer/);
  });

  it("shows the server's error, e.g. no API key", async () => {
    op.mockRejectedValue(new Error("Setlist lookup is not set up on this server"));
    render(<SetlistSection event={base} onUpdated={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not set up/);
  });

  it("summarizes nothing-found and failures plainly", () => {
    expect(summarize([{ act: "A", status: "not_found" }])).toMatch(/no setlist for this show yet/);
    expect(summarize([{ act: "A", status: "error" }])).toMatch(/Could not reach/);
  });
});
