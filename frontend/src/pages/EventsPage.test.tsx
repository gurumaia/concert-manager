// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventView } from "../types";
import { EventsPage } from "./EventsPage";

const day = 24 * 3600_000;
const ev = (id: string, title: string, date: string, addedDaysAgo: number, extra: Partial<EventView> = {}): EventView => ({
  id, title, date, createdAt: new Date(Date.now() - addedDaysAgo * day).toISOString(), updatedAt: "", venue: null, rsvp: null, ...extra,
});
const future = (n: number) => new Date(Date.now() + n * day).toISOString().slice(0, 10);

const events = [
  ev("1", "Fresh Show", future(10), 2),
  ev("2", "Old Show", future(20), 30),
  ev("3", "Fresh Going", future(12), 1, { rsvp: { eventId: "3", status: "going", sharedWith: [], createdAt: "", updatedAt: "" } }),
];

const renderPage = (list = events) => render(<EventsPage events={list} venues={[]} reload={() => {}} loading={false} />);
afterEach(cleanup);

describe("EventsPage: added this week", () => {
  it("lifts shows added in the last 7 days into a section at the top, marked New", () => {
    renderPage();
    const section = screen.getByRole("region", { name: /Added this week · 1/ }); // "To decide" tab: only Fresh Show is both new and undecided
    expect(within(section).getByText("Fresh Show")).toBeTruthy();
    expect(within(section).getByText("New · 2 days ago")).toBeTruthy();
    // the old show stays in its month group, unmarked
    expect(screen.getByText("Old Show")).toBeTruthy();
    expect(screen.getAllByText(/^New · /)).toHaveLength(1);
  });

  it("shows only new shows from the current tab, and goes back", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Show only new" }));
    expect(screen.queryByText("Old Show")).toBeNull();
    expect(screen.getByText("Fresh Show")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    expect(screen.getByText("Fresh Going")).toBeTruthy(); // new shows of any RSVP state, same filter applied to the other tab
    expect(screen.queryByText("Old Show")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Old Show")).toBeTruthy();
  });

  it("explains an empty result and offers a way back", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Show only new" }));
    fireEvent.click(screen.getByRole("tab", { name: /Interested/ })); // nothing new in this tab
    expect(screen.getByText(/Nothing was added in the last 7 days here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all shows" }));
    expect(screen.queryByText(/Nothing was added/)).toBeNull();
  });

  it("shows no section when nothing is new", () => {
    renderPage([ev("2", "Old Show", future(20), 30)]);
    expect(screen.queryByRole("region", { name: /Added this week/ })).toBeNull();
    expect(screen.queryByText(/^New · /)).toBeNull();
  });
});

describe("EventsPage: genre filter", () => {
  const g = (id: string, title: string, genre: string | undefined, rsvp = false): EventView =>
    ev(id, title, future(10 + Number(id)), 30, { genre, ...(rsvp ? { rsvp: { eventId: id, status: "going", sharedWith: [], createdAt: "", updatedAt: "" } } : {}) });
  const list = [
    g("1", "Slayer", "Thrash metal"), g("2", "Metallica", "Heavy metal"), g("3", "ZZ Top", "Rock"),
    g("4", "Dead Fish", "Hardcore punk"), g("5", "Booked Rock Band", "Rock", true), g("6", "No Genre", undefined),
  ];
  const chip = (name: RegExp) => screen.getByRole("button", { name });

  it("offers one chip per genre with counts for the current tab, and no chip for shows without a genre", () => {
    renderPage(list);
    expect(chip(/^Rock, 1 show here/)).toBeTruthy(); // 2 rocks overall, one of them already decided
    expect(chip(/^Thrash metal, 1 show/)).toBeTruthy();
    const group = screen.getByRole("group", { name: "Filter by genre" });
    expect(within(group).queryByText(/No Genre/)).toBeNull();
    expect(within(group).getAllByRole("button")).toHaveLength(1 + 4); // All genres + Rock, Thrash metal, Heavy metal, Hardcore punk
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    expect(chip(/^Rock, 2 shows here/)).toBeTruthy();
  });

  it("filters to the selected genres (any of them), and 'All genres' clears it", () => {
    renderPage(list);
    fireEvent.click(chip(/^Rock,/));
    expect(screen.getByText("ZZ Top")).toBeTruthy();
    expect(screen.queryByText("Slayer")).toBeNull();
    fireEvent.click(chip(/^Thrash metal,/));
    expect(screen.getByText("Slayer")).toBeTruthy();
    expect(screen.getByText("ZZ Top")).toBeTruthy();
    expect(screen.queryByText("Dead Fish")).toBeNull();
    expect(chip(/^Rock,/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All genres" }));
    expect(screen.getByText("Dead Fish")).toBeTruthy();
    expect(chip(/^Rock,/).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a selected genre visible and dimmed when the tab has none, and offers to clear it from the empty state", () => {
    renderPage(list);
    fireEvent.click(chip(/^Rock,/));
    fireEvent.click(screen.getByRole("tab", { name: /Interested/ })); // nobody is interested in anything
    expect(chip(/^Rock, 0 shows here/).className).toContain("zero");
    fireEvent.click(screen.getByRole("button", { name: "Clear genre filter" }));
    expect(chip(/^Rock,/).getAttribute("aria-pressed")).toBe("false");
  });

  it("collapses a long genre list behind '+N more' but never hides a selected one", () => {
    const many = Array.from({ length: 12 }, (_, i) => g(String(i + 1), `Show ${i + 1}`, `Genre${String.fromCharCode(65 + i)}`));
    renderPage(many);
    expect(screen.getByRole("button", { name: "+4 more" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^GenreL,/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+4 more" }));
    fireEvent.click(chip(/^GenreL,/));
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(chip(/^GenreL,/).getAttribute("aria-pressed")).toBe("true"); // still shown
  });
});

describe("EventsPage: status tabs", () => {
  it("colours each status tab, with All neutral", () => {
    renderPage();
    const style = (re: RegExp) => screen.getByRole("tab", { name: re }).getAttribute("style") ?? "";
    expect(style(/Going/)).toContain("--going");
    expect(style(/Interested/)).toContain("--interested");
    expect(screen.getByRole("tab", { name: /All/ }).className).toContain("neutral");
  });
});
