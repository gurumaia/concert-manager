import { describe, expect, it } from "vitest";
import { addedLabel, dateLabel, isNewEvent, monthKey, priceLabel, timeLabel } from "./format";

describe("format", () => {
  it("formats dates without time-zone drift", () => {
    expect(dateLabel("2026-11-11")).toBe("Wed, Nov 11");
    expect(monthKey("2026-11-11")).toBe("2026-11");
  });
  it("shows the fee separately and 'from' for several tiers", () => {
    expect(priceLabel({ currency: "BRL", tiers: [{ name: "A", price: 300, fee: 45 }, { name: "B", price: 600 }] })).toMatch(/^from .*300\.00 \+ .*45\.00 fee$/);
    expect(priceLabel({ tiers: [] })).toBeUndefined();
  });
  it("describes missing times", () => {
    expect(timeLabel({})).toBe("Time TBA");
    expect(timeLabel({ doorsTime: "19:00", startTime: "21:00" })).toBe("Doors 19:00 · Show 21:00");
  });
});


describe("newly added events", () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime(); // 10 Nov 2026, 15:00 local
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const H = 3600_000;

  it("uses a rolling 7-day window on the creation time", () => {
    expect(isNewEvent(ago(1 * H), now)).toBe(true);
    expect(isNewEvent(ago(6 * 24 * H + 23 * H), now)).toBe(true);
    expect(isNewEvent(ago(7 * 24 * H), now)).toBe(false); // exactly 7 days old is out
    expect(isNewEvent(ago(30 * 24 * H), now)).toBe(false);
    expect(isNewEvent(undefined, now)).toBe(false);
    expect(isNewEvent("not a date", now)).toBe(false);
  });

  it("describes how long ago it was added, by elapsed time", () => {
    expect(addedLabel(ago(10 * 60_000), now)).toBe("just now");
    expect(addedLabel(ago(1 * H + 5 * 60_000), now)).toBe("1 hour ago");
    expect(addedLabel(ago(5 * H), now)).toBe("5 hours ago");
    expect(addedLabel(ago(23 * H), now)).toBe("23 hours ago");
    expect(addedLabel(ago(25 * H), now)).toBe("1 day ago");
    expect(addedLabel(ago(3 * 24 * H + H), now)).toBe("3 days ago");
    expect(addedLabel(ago(-5 * H), now)).toBe("just now"); // clock skew never shows a negative time
  });
});
