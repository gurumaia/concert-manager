import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EventView } from "../types";
import { PlaylistsSection, playlistGroups } from "./PlaylistsSection";

const base: EventView = {
  id: "1", title: "Night", date: "2999-01-01", createdAt: "", updatedAt: "", venue: null, past: false,
  rsvp: { status: "going" } as EventView["rsvp"], lineup: [{ name: "Slayer" }, { name: "Anthrax" }],
};
const pl = (act: string, service: string, extra = {}) => ({ act, service, url: `https://x/${act}/${service}`, createdAt: "", ...extra });
afterEach(cleanup);

describe("PlaylistsSection", () => {
  it("groups by act in lineup order, one line per service, with an open link", () => {
    const e = { ...base, playlists: [pl("slayer", "spotify", { title: "Tour", trackCount: 21 }), pl("Slayer", "tidal")] };
    render(<PlaylistsSection event={e} />);
    expect(screen.getByText("Tour")).toBeTruthy();
    expect(screen.getByText("Spotify · 21 songs")).toBeTruthy();
    expect(screen.getByText("Slayer on Tidal")).toBeTruthy(); // unknown service keeps working
    expect(screen.getByRole("link", { name: "Open Tour on Spotify" }).getAttribute("href")).toBe("https://x/slayer/spotify");
    expect(screen.getByText(/no playlist yet/).textContent).toContain("Anthrax");
  });

  it("hides when there is nothing to show, and the empty hint is only for my upcoming going shows", () => {
    expect(render(<PlaylistsSection event={{ ...base, rsvp: null }} />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<PlaylistsSection event={{ ...base, past: true }} />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<PlaylistsSection event={base} readOnly />).container.innerHTML).toBe("");
  });

  it("read-only view shows playlists without the empty hints", () => {
    render(<PlaylistsSection event={{ ...base, playlists: [pl("Slayer", "spotify")] }} readOnly />);
    expect(screen.getByRole("link")).toBeTruthy();
    expect(screen.queryByText(/no playlist yet/)).toBeNull();
  });

  it("keeps playlists of an act that left the lineup", () => {
    expect(playlistGroups({ ...base, playlists: [pl("Gone", "spotify")] }).map((g) => g.act)).toEqual(["Slayer", "Anthrax", "Gone"]);
  });
});
