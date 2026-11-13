// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";

const uploadPhoto = vi.fn();
vi.mock("../photos", () => ({ uploadPhoto: (...a: unknown[]) => uploadPhoto(...a) }));
const { EventCard } = await import("./EventCard");

const ev = (extra: Partial<EventView> = {}): EventView => ({ id: "e1", title: "Slayer", date: "2020-01-01", createdAt: "", updatedAt: "", venue: null, rsvp: null, past: true, ...extra });
const drag = () => ({ dataTransfer: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })], types: ["Files"], dropEffect: "" } });
afterEach(() => { cleanup(); uploadPhoto.mockReset(); });

describe("EventCard photo drop", () => {
  it("uploads photos dropped on your own past show", async () => {
    uploadPhoto.mockResolvedValue({});
    const { container } = render(<ul><EventCard event={ev()} onOpen={() => {}} /></ul>);
    const card = container.querySelector("li")!;
    fireEvent.dragEnter(card, drag());
    expect(card.className).toContain("dropping");
    expect(screen.getByText("Drop to add photos to Slayer")).toBeTruthy();
    fireEvent.drop(card, drag());
    expect((await screen.findByRole("status")).textContent).toBe("Added 1 photo.");
    expect(uploadPhoto).toHaveBeenCalledWith("e1", expect.any(File));
  });

  it("ignores drops on upcoming shows and cards that cannot open", async () => {
    for (const el of [
      <EventCard event={ev({ past: false })} onOpen={() => {}} />,
      <EventCard event={ev()} />,
    ]) {
      const { container, unmount } = render(<ul>{el}</ul>);
      const card = container.querySelector("li")!;
      fireEvent.dragEnter(card, drag());
      fireEvent.drop(card, drag());
      await waitFor(() => expect(card.className).not.toContain("dropping"));
      unmount();
    }
    expect(uploadPhoto).not.toHaveBeenCalled();
  });
});
