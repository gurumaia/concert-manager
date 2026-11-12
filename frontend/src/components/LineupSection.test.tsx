// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventView } from "../types";

const op = vi.fn();
vi.mock("../api", () => ({ op: (...a: unknown[]) => op(...a) }));
const { LineupSection } = await import("./LineupSection");

const rsvp = (extra = {}) => ({ eventId: "e1", status: "going" as const, sharedWith: [], createdAt: "", updatedAt: "", ...extra });
const ev = (extra: Partial<EventView> = {}): EventView => ({
  id: "e1", title: "Night", date: "2020-01-01", createdAt: "", updatedAt: "", venue: null, past: true, attended: true, rsvp: rsvp(),
  lineup: [{ name: "Headliner", role: "headliner", startTime: "21:00" }, { name: "Opener Band", role: "opener", startTime: "19:30" }], ...extra,
});
beforeEach(() => { vi.useFakeTimers(); op.mockResolvedValue({}); });
afterEach(() => { cleanup(); op.mockReset(); vi.useRealTimers(); });
const flush = async (ms = 600) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("LineupSection", () => {
  it("lists the acts with role and set time, and has no scoring for a show you did not attend", () => {
    render(<LineupSection event={ev({ past: false })} />);
    expect(screen.getByText("Headliner", { selector: ".nm" })).toBeTruthy();
    expect(screen.getByText("Opener")).toBeTruthy();
    expect(screen.getByText("19:30")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("scores each act and the whole night, saving in the background without a save button", async () => {
    render(<LineupSection event={ev()} />);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("Headliner: Score slider"), { target: { value: "9.5" } });
    fireEvent.change(screen.getByLabelText("Opener Band: Score slider"), { target: { value: "5" } });
    expect(op).not.toHaveBeenCalled(); // batched
    await flush();
    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith("set_scores", { eventId: "e1", actScores: { Headliner: 9.5, "Opener Band": 5 } });
    expect(screen.getByRole("status").textContent).toContain("Saved automatically");
    fireEvent.change(screen.getByLabelText("Whole night: Score slider"), { target: { value: "9" } });
    await flush();
    expect(op).toHaveBeenLastCalledWith("set_scores", { eventId: "e1", score: 9 });
  });

  it("typing a number and clearing an act are saved too (null clears)", async () => {
    render(<LineupSection event={ev({ rsvp: rsvp({ actScores: { Headliner: 8 } }) })} />);
    expect((screen.getByLabelText("Headliner: Score, 0 to 10") as HTMLInputElement).value).toBe("8");
    fireEvent.click(screen.getByRole("button", { name: "Clear score for Headliner" }));
    const box = screen.getByLabelText("Opener Band: Score, 0 to 10");
    fireEvent.change(box, { target: { value: "6,3" } }); fireEvent.blur(box);
    await flush();
    expect(op).toHaveBeenCalledWith("set_scores", { eventId: "e1", actScores: { Headliner: null, "Opener Band": 6.5 } });
  });

  it("keeps the clear slot in unrated rows so the sliders line up", () => {
    render(<LineupSection event={ev({ rsvp: rsvp({ actScores: { Headliner: 8 } }) })} />);
    const slots = document.querySelectorAll(".lineup-row .score-row .icon-btn");
    expect(slots).toHaveLength(2); // one per act, rated or not
    expect([...slots].map((b) => (b as HTMLElement).style.visibility)).toEqual(["", "hidden"]);
    expect(screen.queryByRole("button", { name: "Clear score for Opener Band" })).toBeNull(); // hidden from assistive tech too
  });

  it("one request at a time: edits made while saving go out right after, newest value last", async () => {
    let release!: () => void;
    op.mockImplementationOnce(() => new Promise<void>((r) => { release = () => r(); }));
    render(<LineupSection event={ev()} />);
    const slider = screen.getByLabelText("Headliner: Score slider");
    fireEvent.change(slider, { target: { value: "3" } });
    await flush();
    fireEvent.change(slider, { target: { value: "7" } });
    await flush();
    expect(op).toHaveBeenCalledTimes(1); // still waiting for the first
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(op).toHaveBeenCalledTimes(2);
    expect(op).toHaveBeenLastCalledWith("set_scores", { eventId: "e1", actScores: { Headliner: 7 } });
  });

  it("sends pending edits when the view closes", async () => {
    const { unmount } = render(<LineupSection event={ev()} />);
    fireEvent.change(screen.getByLabelText("Headliner: Score slider"), { target: { value: "4" } });
    unmount();
    await flush(0);
    expect(op).toHaveBeenCalledWith("set_scores", { eventId: "e1", actScores: { Headliner: 4 } });
  });

  it("reports a failed save and retries it on request", async () => {
    op.mockRejectedValueOnce(new Error("offline"));
    render(<LineupSection event={ev()} />);
    fireEvent.change(screen.getByLabelText("Headliner: Score slider"), { target: { value: "4" } });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush(0);
    expect(op).toHaveBeenCalledTimes(2);
    expect(op).toHaveBeenLastCalledWith("set_scores", { eventId: "e1", actScores: { Headliner: 4 } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a single act (or no lineup) gets just one score, 'How was it?'", async () => {
    render(<LineupSection event={ev({ lineup: [{ name: "Solo" }] })} />);
    expect(screen.getAllByRole("slider")).toHaveLength(1);
    expect(screen.getByText("How was it?")).toBeTruthy();
    cleanup();
    render(<LineupSection event={ev({ lineup: undefined })} />);
    fireEvent.change(screen.getByLabelText("Score slider"), { target: { value: "8" } });
    await flush();
    expect(op).toHaveBeenCalledWith("set_scores", { eventId: "e1", score: 8 });
  });

  it("read-only (shared) view shows act scores but no controls", () => {
    render(<LineupSection readOnly event={ev({ rsvp: rsvp({ actScores: { Headliner: 9.5 } }) })} />);
    expect(screen.getByLabelText("Score 9.5 out of 10")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
