import { describe, expect, it, vi } from "vitest";
import { bridgeTransport, decisionLine, filtersFrom, pageTab } from "./bridge";

const text = (t: string, isError = false) => ({ isError, content: [{ type: "text", text: t }] });

describe("bridgeTransport", () => {
  it("calls the tool through the host and parses the JSON result", async () => {
    const callServerTool = vi.fn().mockResolvedValue(text('{"warnings":[]}'));
    expect(await bridgeTransport({ callServerTool } as never)("set_rsvp", { eventId: "1", status: "going" })).toEqual({ warnings: [] });
    expect(callServerTool).toHaveBeenCalledWith({ name: "set_rsvp", arguments: { eventId: "1", status: "going" } });
  });
  it("turns tool errors into thrown errors with the server's message", async () => {
    const t = bridgeTransport({ callServerTool: vi.fn().mockResolvedValue(text("Event nope not found", true)) } as never);
    await expect(t("set_rsvp", {})).rejects.toThrow("Event nope not found");
  });
  it("rejects non-JSON replies", async () => {
    const t = bridgeTransport({ callServerTool: vi.fn().mockResolvedValue(text("hello")) } as never);
    await expect(t("list_events", {})).rejects.toThrow(/Unexpected reply/);
  });
});

describe("tool-result helpers", () => {
  it("reads the resolved filters and ignores junk", () => {
    expect(filtersFrom({ tab: "going", newSince: "2026-11-03T00:00:00.000Z", genre: "Metal", counts: { all: 1 } })).toMatchObject({ tab: "going", genre: "Metal" });
    expect(filtersFrom({ tab: 5 })?.tab).toBeUndefined();
    expect(filtersFrom(undefined)).toBeUndefined();
  });
  it("maps the tool's tab names to the page's", () => {
    expect(pageTab("to_decide")).toBe("undecided");
    expect(pageTab("past")).toBe("past");
    expect(pageTab("nonsense")).toBeUndefined();
  });
  it("writes a decision as one line", () => {
    expect(decisionLine({ id: "a1", title: "Slayer", date: "2026-12-17", venue: { name: "Nubank Parque" } }, "going")).toBe("Going: Slayer · 2026-12-17 · Nubank Parque (id a1)");
    expect(decisionLine({ id: "a2", title: "X", date: "2026-12-18" }, "skipped")).toBe("Skipped: X · 2026-12-18 (id a2)");
  });
});
