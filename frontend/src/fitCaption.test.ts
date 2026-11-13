import { describe, expect, it } from "vitest";
import { fitCaption } from "./fitCaption";

// Every character is 10 wide, so "avail" below is a number of characters times 10.
const m = (s: string) => s.length * 10;
const fit = (text: string, chars: number, suffix = "") => fitCaption(text, suffix, chars * 10, m);

describe("fitCaption", () => {
  it("shows a caption that fits as it is", () => {
    expect(fit("Slayer", 10)).toEqual({ text: "Slayer", scale: 1, cut: false });
  });

  it("shrinks the text a little rather than cutting it", () => {
    const r = fit("Avenged Sevenfold", 14); // 17 characters in 14: 82%
    expect(r).toMatchObject({ text: "Avenged Sevenfold", cut: false });
    expect(r.scale).toBeCloseTo(0.82, 2);
  });

  it("leaves out a word that did not half fit", () => {
    // 12 characters is too little even shrunk (70%); "Avenged Sev…" would be the cut, and 3 of 9 letters of "Sevenfold" is under half
    expect(fit("Avenged Sevenfold", 12)).toEqual({ text: "Avenged…", scale: 1, cut: true });
  });

  it("keeps a word that was more than half there, shrinking to make it fit", () => {
    // at 23 characters the cut is "Avenged Sevenfold Reun…": 4 of the 7 letters of "Reunion" fit, so the whole word is kept
    const r = fit("Avenged Sevenfold Reunion Tour 2026 Edition", 23);
    expect(r).toMatchObject({ text: "Avenged Sevenfold Reunion…", cut: true });
    expect(r.scale).toBeCloseTo(0.88, 2);
  });

  it("never ends on punctuation", () => {
    expect(fit("Angra Reunion: Holy Land", 16).text).toBe("Angra Reunion…");
    expect(fit("Metallica - Life Burns Faster", 13).text).toBe("Metallica…");
  });

  it("never ends on a lone one-letter word", () => {
    expect(fit("Laufey: A Bewitching Night", 12).text).toBe("Laufey…");
    expect(fit("Slayer & Friends Live", 11).text).toBe("Slayer…");
  });

  it("keeps the suffix and the room it needs: more than half of 'Sevenfold' fits, so the whole word stays", () => {
    const r = fit("Avenged Sevenfold Reunion Tour", 20, " · Jan");
    expect(r).toMatchObject({ text: "Avenged Sevenfold…", cut: true });
    expect(r.scale).toBeCloseTo(0.83, 2);
    expect(fit("Avenged Sevenfold Reunion Tour", 16, " · Jan")).toMatchObject({ text: "Avenged…", scale: 1 });
  });

  it("cuts inside a word only when the first word alone is too long", () => {
    expect(fit("Supercalifragilistic", 9)).toEqual({ text: "Supercal…", scale: 1, cut: true });
  });
});
