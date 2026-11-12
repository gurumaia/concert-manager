// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";
import { EventCard } from "./EventCard";

const ev = (extra: Partial<EventView> = {}): EventView => ({ id: "e1", title: "Slayer", date: "2020-01-01", createdAt: "", updatedAt: "", venue: null, rsvp: { status: "going", sharedWith: [], eventId: "e1", createdAt: "", updatedAt: "" }, past: true, attended: true, photoCount: 3, ...extra });
afterEach(cleanup);

describe("EventCard photo counter", () => {
  it("shows the count and opens straight to the photos, not the plain details", () => {
    const onOpen = vi.fn();
    render(<ul><EventCard event={ev()} onOpen={onOpen} /></ul>);
    const b = screen.getByRole("button", { name: "3 photos of Slayer. Open photos" });
    expect(b.textContent).toBe("3");
    fireEvent.click(b);
    expect(onOpen).toHaveBeenCalledWith("photos");
  });
  it("the card body still opens the plain details", () => {
    const onOpen = vi.fn();
    render(<ul><EventCard event={ev()} onOpen={onOpen} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: /Slayer, .*Open details/ }));
    expect(onOpen).toHaveBeenCalledWith(); // no target
  });
  it("is hidden with no photos, singular for one, and absent on upcoming, shared and read-only cards", () => {
    const { rerender } = render(<ul><EventCard event={ev({ photoCount: 0 })} onOpen={() => {}} /></ul>);
    expect(screen.queryByRole("button", { name: /photo/ })).toBeNull();
    rerender(<ul><EventCard event={ev({ photoCount: 1 })} onOpen={() => {}} /></ul>);
    expect(screen.getByRole("button", { name: "1 photo of Slayer. Open photos" })).toBeTruthy();
    for (const el of [<EventCard event={ev({ past: false })} onOpen={() => {}} />, <EventCard event={ev()} onOpen={() => {}} sharedBy="Ana" />, <EventCard event={ev()} />]) {
      rerender(<ul>{el}</ul>);
      expect(screen.queryByRole("button", { name: /Open photos/ })).toBeNull();
    }
  });
});
