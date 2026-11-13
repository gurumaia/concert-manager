// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagLosses } from "./TagLosses";

const op = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ op }));
afterEach(() => { cleanup(); op.mockReset(); vi.unstubAllGlobals(); });

const loss = { ownerId: "o", ownerName: "Gustavo", eventId: "e1", title: "Metallica", date: "2026-03-22", venue: "Allianz Parque", photoCount: 2 };

describe("TagLosses", () => {
  it("renders nothing when nobody took you off a show", async () => {
    op.mockResolvedValue([]);
    const { container } = render(<TagLosses onChanged={() => {}} />);
    await waitFor(() => expect(op).toHaveBeenCalledWith("list_tag_losses"));
    expect(container.textContent).toBe("");
  });

  it("offers a copy, says what comes with it, and keeps it on request", async () => {
    op.mockResolvedValueOnce([loss]).mockResolvedValue([]);
    const changed = vi.fn();
    render(<TagLosses onChanged={changed} />);
    expect((await screen.findByText(/took you off/)).parentElement!.textContent).toContain("Your RSVP and score and 2 photos come with it");
    fireEvent.click(screen.getByRole("button", { name: "Keep a copy" }));
    await waitFor(() => expect(op).toHaveBeenCalledWith("resolve_tag_loss", { ownerId: "o", eventId: "e1", keep: true }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("asks before deleting photos, and does nothing if you change your mind", async () => {
    op.mockResolvedValue([loss]);
    const confirmFn = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmFn);
    render(<TagLosses onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "No thanks" }));
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("2 photos"));
    expect(op).not.toHaveBeenCalledWith("resolve_tag_loss", expect.anything());
  });
});
