// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";
import { EventsPage, type Embed } from "./EventsPage";

const op = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ op }));

const day = 24 * 3600_000;
const future = (n: number) => new Date(Date.now() + n * day).toISOString().slice(0, 10);
const ev = (id: string, title: string, addedDaysAgo: number, extra: Partial<EventView> = {}): EventView => ({
  id, title, date: future(10 + Number(id)), createdAt: new Date(Date.now() - addedDaysAgo * day).toISOString(), updatedAt: "",
  venue: { id: "v1", name: "Tokio Hall", city: "São Paulo", createdAt: "", updatedAt: "" }, venueId: "v1", rsvp: null, genre: "Metal", ...extra,
});
const going = { eventId: "3", status: "going" as const, sharedWith: [], createdAt: "", updatedAt: "" };
const events = [ev("1", "Fresh Show", 2), ev("2", "Old Show", 30, { genre: "Jazz" }), ev("3", "Going Show", 20, { rsvp: going })];

const renderPage = (embed: Embed, reload = vi.fn(async () => {})) =>
  render(<EventsPage events={events} venues={[]} reload={reload} loading={false} embed={embed} />);

beforeEach(() => { op.mockReset(); op.mockResolvedValue({ warnings: [] }); });
afterEach(cleanup);

describe("EventsPage inside Claude (embed)", () => {
  it("has no add button and no details drawer", () => {
    renderPage({});
    expect(screen.queryByRole("button", { name: /Add event/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open details/ })).toBeNull(); // the card body is plain content without a link
  });

  it("opens with the filters the tool call chose", () => {
    renderPage({ initial: { tab: "going" } });
    expect(screen.getByRole("tab", { name: /Going/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Going Show")).toBeTruthy();
    expect(screen.queryByText("Fresh Show")).toBeNull();
    cleanup();
    renderPage({ initial: { tab: "all", genre: "jazz" } });
    expect(screen.getByText("Old Show")).toBeTruthy();
    expect(screen.queryByText("Fresh Show")).toBeNull();
    cleanup();
    renderPage({ initial: { tab: "all", text: "going" } });
    expect(screen.getAllByRole("listitem").length).toBe(1);
  });

  it("judges NEW against newSince, not a fixed 7 days", () => {
    renderPage({ newSince: Date.now() - 25 * day, initial: { tab: "all" } });
    const section = screen.getByRole("region", { name: /Added since .* · 2/ }); // Fresh (2d) and Going (20d); Old (30d) is not
    expect(within(section).getByText("Fresh Show")).toBeTruthy();
    expect(within(section).getByText("Going Show")).toBeTruthy();
    expect(within(section).queryByText("Old Show")).toBeNull();
    cleanup();
    renderPage({ newSince: Date.now() - 7 * day });
    expect(screen.getByRole("region", { name: /Added this week · 1/ })).toBeTruthy();
  });

  it("sends RSVPs through the bridge op, refreshes in place and reports the decision", async () => {
    const onDecision = vi.fn();
    const reload = vi.fn(async () => {});
    renderPage({ onDecision }, reload);
    const card = screen.getByText("Fresh Show").closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Going" }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1));
    expect(op).toHaveBeenCalledWith("set_rsvp", { eventId: "1", status: "going" });
    expect(reload).toHaveBeenCalled();
    expect(onDecision.mock.calls[0]![0]).toMatchObject({ from: null, to: "going", undo: false, event: { id: "1" } });
  });

  it("Undo of a first decision removes the RSVP; Undo of a change restores the previous status", async () => {
    const onDecision = vi.fn();
    renderPage({ onDecision });
    fireEvent.click(within(screen.getByText("Fresh Show").closest("li")!).getByRole("button", { name: "Skip" }));
    const bar = await screen.findByText(/Skipped:/);
    fireEvent.click(within(bar.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(op).toHaveBeenCalledWith("remove_rsvp", { eventId: "1" }));
    expect(onDecision).toHaveBeenLastCalledWith(expect.objectContaining({ from: "skipped", to: null, undo: true }));
    expect(screen.queryByText(/Skipped:/)).toBeNull();

    cleanup(); op.mockClear();
    renderPage({ onDecision, initial: { tab: "going" } });
    fireEvent.click(within(screen.getByText("Going Show").closest("li")!).getByRole("button", { name: "Interested" }));
    const bar2 = await screen.findByText(/Interested:/);
    fireEvent.click(within(bar2.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(op).toHaveBeenLastCalledWith("set_rsvp", { eventId: "3", status: "going" }));
  });

  it("shows overlap warnings inline instead of alert()", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    op.mockResolvedValue({ warnings: ['Conflicts with "X" on 2026-12-01 (you are going).'] });
    renderPage({});
    fireEvent.click(within(screen.getByText("Fresh Show").closest("li")!).getByRole("button", { name: "Going" }));
    expect(await screen.findByText(/Conflicts with "X"/)).toBeTruthy();
    expect(alert).not.toHaveBeenCalled();
  });

  it("shows a failed save as an error and records nothing", async () => {
    const onDecision = vi.fn();
    op.mockRejectedValue(new Error("Calendar not connected"));
    renderPage({ onDecision });
    fireEvent.click(within(screen.getByText("Fresh Show").closest("li")!).getByRole("button", { name: "Going" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Calendar not connected");
    expect(onDecision).not.toHaveBeenCalled();
    expect(screen.queryByText(/Undo/)).toBeNull();
  });

  it("opens the ticket page through the host when the show has one", () => {
    const openLink = vi.fn();
    render(<EventsPage events={[ev("1", "Linked", 1, { ticketUrl: "https://tix.example/1" })]} venues={[]} reload={() => {}} loading={false} embed={{ openLink }} />);
    fireEvent.click(screen.getByRole("button", { name: /Open the ticket page/ }));
    expect(openLink).toHaveBeenCalledWith("https://tix.example/1");
  });
});
