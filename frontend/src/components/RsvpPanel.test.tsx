// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";
import { RsvpPanel } from "./RsvpPanel";

const op = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ op }));
afterEach(() => { cleanup(); op.mockReset(); });

const rsvp = { eventId: "e1", status: "going" as const, sharedWith: [], createdAt: "", updatedAt: "" };
const event = (extra: Partial<EventView> = {}): EventView => ({ id: "e1", title: "Metallica", date: "2020-03-22", createdAt: "", updatedAt: "", venue: null, rsvp, past: true, ...extra });

describe("RsvpPanel on a show someone tagged you on", () => {
  it("shows only your answer and notes: no tickets, no people, no sharing", () => {
    render(<RsvpPanel event={event({ tagged: true })} onChanged={() => {}} tagged />);
    expect(screen.getByRole("button", { name: "Attended" })).toBeTruthy();
    expect(screen.getByLabelText("Notes")).toBeTruthy();
    for (const l of ["Tier", "Tickets", "Going with"]) expect(screen.queryByLabelText(l)).toBeNull();
    expect(screen.queryByText("Going with")).toBeNull();
    expect(op).not.toHaveBeenCalledWith("list_people");
  });

  it("saves just the status and notes", async () => {
    op.mockResolvedValue({ rsvp: { ...rsvp, notes: "great" }, warnings: [], calendar: { status: "skipped" } });
    render(<RsvpPanel event={event({ tagged: true })} onChanged={() => {}} tagged />);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "great" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(op).toHaveBeenCalledWith("set_rsvp", { eventId: "e1", status: "going", notes: "great" }));
  });
});
