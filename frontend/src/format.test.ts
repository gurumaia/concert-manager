import { describe, expect, it } from "vitest";
import { dateLabel, monthKey, priceLabel, timeLabel } from "./format";

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
