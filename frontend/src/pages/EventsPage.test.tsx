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
