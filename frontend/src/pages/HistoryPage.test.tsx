// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryPage } from "./HistoryPage";

const rsvp = { eventId: "x", status: "attended", sharedWith: [], createdAt: "", updatedAt: "" };
const mk = (id: string, date: string, title: string, extra = {}) => ({ id, title, date, createdAt: "", updatedAt: "", venue: null, rsvp, ...extra });
const withC = (companions: string[]) => ({ rsvp: { ...rsvp, companions } });
const EVENTS = [
  mk("1", "2026-04-06", "Sepultura", { genre: "Thrash metal", ...withC(["Ana"]) }),
  mk("2", "2014-07-18", "Iron Maiden", withC(["ana ", "Bruno"])),
  mk("3", "2014-02-01", "Sepultura"),
  mk("4", "2006-05-05", "Caetano Veloso"),
];

function mockApi(events: unknown[]) {
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify({ devAuth: true }));
    calls.push({ name: url.split("/").pop(), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { total: events.length, events } }));
  }));
  return calls;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("HistoryPage", () => {
  it("asks only for attended shows, groups them by year (newest first) and shows the span", async () => {
    const calls = mockApi(EVENTS);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    expect(calls[0].body).toMatchObject({ rsvp: "attended", sort: "desc" });
    expect(screen.getByText("2006 – 2026")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent).filter((t) => /^\d{4}$/.test(t ?? ""))).toEqual(["2026", "2014", "2006"]);
  });

  it("filters by the year chosen on the chart and clears again", async () => {
    mockApi(EVENTS);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    fireEvent.click(screen.getByRole("button", { name: "2014: 2 shows" }));
    expect(screen.queryByRole("button", { name: /^Caetano Veloso, .*Open details/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^(Iron Maiden|Sepultura), .*2014/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /^Caetano Veloso, .*Open details/ })).toBeTruthy();
  });

  it("searches, and clicking a top artist filters to that artist", async () => {
    mockApi(EVENTS);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    fireEvent.click(within(screen.getByText("Most seen").closest("section")!).getByRole("button", { name: /Sepultura/ }));
    expect((screen.getByLabelText("Search your history") as HTMLInputElement).value).toBe("Sepultura");
    expect(screen.queryByRole("button", { name: /^Iron Maiden, .*Open details/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search your history"), { target: { value: "zzz" } });
    expect(screen.getByText("No shows match.")).toBeTruthy();
  });

  it("explains an empty history", async () => {
    mockApi([]);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("No shows in your history yet.")).toBeTruthy());
  });

  it("pages through more than 500 shows", async () => {
    const many = Array.from({ length: 3 }, (_, i) => mk(String(i), `2020-01-0${i + 1}`, `Band ${i}`));
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config") return new Response(JSON.stringify({ devAuth: true }));
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return new Response(JSON.stringify({ ok: true, result: { total: 501, events: body.offset ? many.slice(2) : many.slice(0, 2) } }));
    }));
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    expect(calls.filter((c) => "offset" in c).map((c) => c.offset)).toEqual([0, 500]); // (the people list is fetched too)
    expect(screen.getAllByRole("button", { name: /^Band \d, .*Open details/ })).toHaveLength(3);
  });

  it("lists the people you went with (spelling variants merged) and Alone, and filters by them", async () => {
    mockApi(EVENTS);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    const strip = within(screen.getByRole("region", { name: "Who I went with" }));
    expect(strip.getByRole("button", { name: "Ana, 2 shows" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "Bruno, 1 show" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "Alone, 2 shows" })).toBeTruthy();
    // Nothing chosen: every show is listed.
    expect(screen.getAllByRole("button", { name: /Open details/ })).toHaveLength(4);
    fireEvent.click(strip.getByRole("button", { name: "Ana, 2 shows" }));
    expect(screen.getAllByRole("button", { name: /Open details/ })).toHaveLength(2);
    expect(screen.getAllByText("with Ana").length).toBeGreaterThan(0);
    // The chart splits each year's bar: 2014 had 2 shows, 1 of them with Ana.
    expect(screen.getByRole("button", { name: "2014: 1 of 2 shows with Ana" })).toBeTruthy();
    // Choosing it again clears the filter.
    fireEvent.click(strip.getByRole("button", { name: "Ana, 2 shows" }));
    expect(screen.getAllByRole("button", { name: /Open details/ })).toHaveLength(4);
    fireEvent.click(strip.getByRole("button", { name: "Alone, 2 shows" }));
    expect(screen.getAllByRole("button", { name: /Open details/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Iron Maiden, .*Open details/ })).toBeNull();
  });

  it("always offers Alone, even when no companions were ever recorded", async () => {
    mockApi([mk("1", "2020-01-01", "Solo")]);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    expect(screen.getByRole("button", { name: "Alone, 1 show" })).toBeTruthy();
    expect(screen.getByText(/Add names under/)).toBeTruthy();
  });

  it("filters to the last 12 months", async () => {
    const today = new Date(), iso = (d: Date) => d.toISOString().slice(0, 10);
    const recent = iso(new Date(today.getFullYear(), today.getMonth() - 2, 1)), old = iso(new Date(today.getFullYear() - 3, 5, 1));
    mockApi([mk("1", recent, "Recent Band"), mk("2", old, "Old Band")]);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "12m" } });
    expect(screen.getByRole("button", { name: /^Recent Band, .*Open details/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Old Band, .*Open details/ })).toBeNull();
  });

  it("asks about shows from the last two weeks, lets you mark one as not attended, and remembers 'I went to all'", async () => {
    const day = (ago: number) => { const d = new Date(Date.now() - ago * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    localStorage.clear();
    const calls = mockApi([mk("9", day(3), "Last Week Band"), ...EVENTS]);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    const nudge = (await screen.findByRole("region", { name: "Recent shows to confirm" }));
    expect(within(nudge).getByText("Last Week Band")).toBeTruthy();
    expect(within(nudge).queryByText("Sepultura")).toBeNull();
    fireEvent.click(within(nudge).getByRole("button", { name: "I didn't go to Last Week Band" }));
    await waitFor(() => expect(calls.some((c) => c.name === "set_rsvp" && c.body.status === "skipped" && c.body.eventId === "9")).toBe(true));
    cleanup();
    mockApi([mk("9", day(3), "Last Week Band")]);
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "I went to all of these" }));
    expect(screen.queryByRole("region", { name: "Recent shows to confirm" })).toBeNull();
    cleanup();
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    expect(screen.queryByRole("region", { name: "Recent shows to confirm" })).toBeNull();
    localStorage.clear();
  });

  it("links the chosen person to an email once, for every show with them", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config") return new Response(JSON.stringify({ devAuth: true }));
      const name = url.split("/").pop(); const body = JSON.parse(String(init?.body)); calls.push({ name, body });
      const result = name === "list_people" ? [] : name === "set_person_email" ? { shows: 2, person: { key: "ana", name: "Ana", email: body.email } } : { total: EVENTS.length, events: EVENTS };
      return new Response(JSON.stringify({ ok: true, result }));
    }));
    render(<HistoryPage venues={[]} reload={vi.fn()} />);
    await screen.findByText("Shows I've been to");
    expect(screen.queryByLabelText("Ana’s email")).toBeNull(); // only once a person is chosen
    fireEvent.click(within(screen.getByRole("region", { name: "Who I went with" })).getByRole("button", { name: "Ana, 2 shows" }));
    const input = screen.getByLabelText("Ana’s email");
    fireEvent.change(input, { target: { value: "not an email" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Ana@X.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/2 shows with Ana shared with ana@x.com/);
    expect(calls.find((c) => c.name === "set_person_email")?.body).toEqual({ name: "Ana", email: "Ana@X.com" });
  });
});

