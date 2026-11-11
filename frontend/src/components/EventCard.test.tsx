// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";
import { EventCard } from "./EventCard";

const base: EventView = {
  id: "1", title: "Slayer", date: "2026-12-17", createdAt: "", updatedAt: "", venue: { id: "v", name: "Nubank Parque", city: "São Paulo", createdAt: "", updatedAt: "" }, rsvp: null,
};
const bare: EventView = { ...base, title: "Dead Fish", venue: null };
const full: EventView = {
  ...base, doorsTime: "17:00", startTime: "21:05", genre: "Thrash metal", saleStatus: "on_sale", currency: "BRL",
  lineup: [{ name: "Slayer" }, { name: "Kreator" }, { name: "Korzus" }], tiers: [{ name: "Pista", price: 180 }],
};

afterEach(cleanup);
const open = vi.fn();
const card = (e: EventView, props: Partial<Parameters<typeof EventCard>[0]> = {}) =>
  render(<ul><EventCard event={e} onOpen={open} onQuick={() => {}} {...props} /></ul>);

describe("EventCard", () => {
  it("shows every slot of a fully described show", () => {
    card(full);
    expect(screen.getByText("Slayer")).toBeTruthy();
    expect(screen.getByText("Kreator, Korzus")).toBeTruthy(); // the headliner is not repeated as a support act
    expect(screen.getByText("Nubank Parque · São Paulo")).toBeTruthy();
    expect(screen.getByText("Doors 17:00 · Show 21:05")).toBeTruthy();
    expect(screen.getByText(/180\.00/)).toBeTruthy();
    expect(screen.getByText("Thrash metal")).toBeTruthy();
    expect(screen.getByText("On sale")).toBeTruthy();
  });

  it("keeps the same slots when data is missing, with a muted TBA instead of nothing", () => {
    card(bare);
    expect(screen.getByText("Time TBA").closest(".line")!.className).toContain("tba");
    expect(screen.getByText("Price TBA").closest(".line")!.className).toContain("tba");
    expect(screen.getByText("Venue TBA")).toBeTruthy();
    expect(screen.queryByText("On sale")).toBeNull();
    expect(document.querySelector(".genre-pill")).toBeNull();
  });

  it("gives the genre pill a hue shared by related genres and stable for the same one", () => {
    const { unmount } = card({ ...base, genre: "Thrash metal" });
    const hue = (document.querySelector(".genre-pill") as HTMLElement).style.getPropertyValue("--h");
    unmount();
    card({ ...base, genre: "Heavy Metal" });
    expect((document.querySelector(".genre-pill") as HTMLElement).style.getPropertyValue("--h")).toBe(hue);
  });

  it("shows three dim RSVP buttons in the footer, none lit until you decide", () => {
    const quick = vi.fn();
    card(bare, { onQuick: quick });
    const foot = document.querySelector(".foot") as HTMLElement;
    const buttons = within(foot).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Going", "Interested", "Skip"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    expect(buttons.every((b) => !b.className.includes(" on"))).toBe(true);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[2]!);
    expect(quick.mock.calls).toEqual([["going"], ["skipped"]]);
  });

  it("lights only the button that matches your RSVP, and clicking it again does nothing", () => {
    const quick = vi.fn();
    card({ ...bare, rsvp: { eventId: "1", status: "interested", sharedWith: [], createdAt: "", updatedAt: "" } }, { onQuick: quick });
    const foot = document.querySelector(".foot") as HTMLElement;
    expect(within(foot).getByRole("button", { name: "Interested" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(foot).getByRole("button", { name: "Interested" }).className).toContain("on interested");
    expect(within(foot).getByRole("button", { name: "Going" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(foot).getByRole("button", { name: "Skip" }).className).not.toContain(" on");
    fireEvent.click(within(foot).getByRole("button", { name: "Interested" }));
    expect(quick).not.toHaveBeenCalled();
    fireEvent.click(within(foot).getByRole("button", { name: "Going" }));
    expect(quick).toHaveBeenCalledWith("going");
  });

  it("shows an Attended badge instead of the buttons once the show is attended", () => {
    card({ ...bare, rsvp: { eventId: "1", status: "attended", sharedWith: [], createdAt: "", updatedAt: "" } });
    const foot = document.querySelector(".foot") as HTMLElement;
    expect(within(foot).getByText("Attended")).toBeTruthy();
    expect(within(foot).queryByRole("button", { name: "Going" })).toBeNull();
  });

  it("shows the sharer's RSVP as a read-only badge on a shared show", () => {
    card({ ...bare, rsvp: { eventId: "1", status: "going", sharedWith: [], createdAt: "", updatedAt: "" } }, { onQuick: undefined, sharedBy: "Her" });
    expect(within(document.querySelector(".foot") as HTMLElement).getByText("Going").className).toContain("badge");
  });

  it("shows who shared it instead of actions on a shared show", () => {
    card(bare, { onQuick: undefined, sharedBy: "Her" });
    expect(screen.getByText("from Her")).toBeTruthy();
  });

  it("opens the details from the card body", () => {
    card(full);
    fireEvent.click(screen.getByRole("button", { name: /Slayer, .*Open details/ }));
    expect(open).toHaveBeenCalled();
  });
});
