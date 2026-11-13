// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewStory, resetMeasurer } from "./ReviewStory";
import type { ReviewData, ReviewShow } from "../types";

const photo = (id: string) => ({ id, url: `/${id}.jpg`, thumbUrl: `/${id}-t.jpg` });
const show = (title: string, date: string, extra: Partial<ReviewShow> = {}): ReviewShow => ({ date, title, lineup: [], companions: [], companionCount: 0, songs: [], photos: [], ...extra });
// intro, best (2-photo slideshow), bookends, outro (two photos are too few for a collage)
const DATA: ReviewData = {
  recipe: { from: "2026-01-01", to: "2026-12-31" }, owner: "Gus",
  shows: [show("Slayer", "2026-03-05", { score: 9, photos: [photo("a"), photo("b")] }), show("Maiden", "2026-09-14", { score: 7 })],
};
const TODAY = "2026-12-31";
// Records the pictures the story asks the browser to fetch ahead of time (new Image().src = ...).
const requested: string[] = [];
class FakeImage { decoding = ""; set src(v: string) { requested.push(v); } decode() { return Promise.resolve(); } }

beforeEach(() => { requested.length = 0; vi.stubGlobal("Image", FakeImage); vi.useFakeTimers(); vi.stubGlobal("matchMedia", () => ({ matches: false })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetMeasurer(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const heading = () => screen.getAllByRole("heading", { level: 2 })[0]!.textContent;

describe("ReviewStory", () => {
  it("starts on the intro and moves on by itself", () => {
    render(<ReviewStory data={DATA} today={TODAY} />);
    expect(heading()).toBe("In 2026 you went to");
    expect(screen.getByLabelText("2 shows")).toBeTruthy();
    tick(6100);
    expect(heading()).toMatch(/Your highest score/);
  });

  it("taps go forward and back, and the left third goes back", () => {
    render(<ReviewStory data={DATA} today={TODAY} />);
    fireEvent.click(screen.getByLabelText("Next slide"));
    expect(heading()).toMatch(/Your highest score/);
    fireEvent.click(screen.getByLabelText("Previous slide"));
    expect(heading()).toBe("In 2026 you went to");
    fireEvent.click(screen.getByLabelText("Previous slide")); // already first: stays
    expect(heading()).toBe("In 2026 you went to");
  });

  it("once paused it stays paused until play is pressed", () => {
    render(<ReviewStory data={DATA} today={TODAY} />);
    fireEvent.click(screen.getByLabelText("Pause"));
    tick(60_000);
    expect(heading()).toBe("In 2026 you went to");
    fireEvent.click(screen.getByLabelText("Next slide")); // navigating does not resume it
    tick(60_000);
    expect(heading()).toMatch(/Your highest score/);
    fireEvent.click(screen.getByLabelText("Play"));
    tick(6100); // the slideshow has 2 photos, 6 s
    expect(heading()).toMatch(/It started with/);
  });

  it("holding the screen pauses it for good, and the release does not change slide", () => {
    render(<ReviewStory data={DATA} today={TODAY} />);
    const next = screen.getByLabelText("Next slide");
    fireEvent.pointerDown(next);
    tick(500);
    fireEvent.pointerUp(next);
    fireEvent.click(next); // what a browser sends when the finger lifts
    expect(screen.getByLabelText("Play")).toBeTruthy();
    expect(heading()).toBe("In 2026 you went to");
    tick(60_000);
    expect(heading()).toBe("In 2026 you went to"); // still paused after letting go
    fireEvent.click(next); // the next plain tap works as usual
    expect(heading()).toMatch(/Your highest score/);
  });

  it("a quick tap is not a hold", () => {
    render(<ReviewStory data={DATA} today={TODAY} />);
    const next = screen.getByLabelText("Next slide");
    fireEvent.pointerDown(next);
    tick(100);
    fireEvent.pointerUp(next);
    fireEvent.click(next);
    tick(500);
    expect(screen.getByLabelText("Pause")).toBeTruthy();
    expect(heading()).toMatch(/Your highest score/);
  });

  it("the photo slideshow has previous and next arrows and keeps its own pace", () => {
    render(<ReviewStory data={DATA} today={TODAY} />);
    fireEvent.click(screen.getByLabelText("Next slide"));
    expect(screen.getByAltText(/1 \/ 2/)).toBeTruthy();
    expect((screen.getByLabelText("Previous photo") as HTMLButtonElement).disabled).toBe(true);
    tick(3100); // moves to the next photo by itself
    expect(screen.getByAltText(/2 \/ 2/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Previous photo"));
    expect(screen.getByAltText(/1 \/ 2/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next photo"));
    expect(screen.getByAltText(/2 \/ 2/)).toBeTruthy();
    expect((screen.getByLabelText("Next photo") as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads photos ahead of time: the next slide's, and the next photos of a slideshow", () => {
    // the Image stub is per file, and the module keeps what it already asked for, so use fresh URLs
    const d: ReviewData = { ...DATA, shows: [show("Slayer", "2026-03-05", { score: 9, photos: [photo("p1"), photo("p2"), photo("p3")] }), show("Maiden", "2026-09-14", { score: 7 })] };
    render(<ReviewStory data={d} today={TODAY} />);
    // on the intro: the collage after it (previews) and the slideshow after that (full photos) are already on their way
    expect(requested).toEqual(["/p1-t.jpg", "/p2-t.jpg", "/p3-t.jpg", "/p1.jpg", "/p2.jpg", "/p3.jpg"]);
    const before = requested.length;
    fireEvent.click(screen.getByLabelText("Next slide"));
    fireEvent.click(screen.getByLabelText("Next slide"));
    tick(3100); // the second photo of the slideshow is showing; everything was requested already, nothing is fetched twice
    expect(requested).toHaveLength(before);
  });

  it("a collage of four is loaded in full before it appears", () => {
    const shows = [show("A", "2026-01-10", { photos: [photo("q1"), photo("q2")] }), show("B", "2026-02-10", { photos: [photo("q3"), photo("q4")] })];
    render(<ReviewStory data={{ ...DATA, shows }} today={TODAY} />);
    const previews = requested.filter((u) => u.endsWith("-t.jpg"));
    expect(previews).toHaveLength(4);
    expect(new Set(previews)).toEqual(new Set(["/q1-t.jpg", "/q2-t.jpg", "/q3-t.jpg", "/q4-t.jpg"]));
  });

  describe("full screen", () => {
    const enable = (on: boolean) => Object.defineProperty(document, "fullscreenEnabled", { value: on, configurable: true });
    afterEach(() => { enable(false); Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true }); });

    it("has no button where the browser cannot do it (iPhone Safari)", () => {
      enable(false);
      render(<ReviewStory data={DATA} today={TODAY} />);
      expect(screen.queryByLabelText("Full screen")).toBeNull();
    });

    it("the button asks the story to fill the screen, and a phone's Play can ask for it by itself", () => {
      enable(true);
      const request = vi.fn(() => Promise.resolve());
      (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = request;
      const { unmount } = render(<ReviewStory data={DATA} today={TODAY} />);
      fireEvent.click(screen.getByLabelText("Full screen"));
      expect(request).toHaveBeenCalledTimes(1);
      unmount();
      request.mockClear();
      render(<ReviewStory data={DATA} today={TODAY} fullscreenOnStart />);
      expect(request).toHaveBeenCalledTimes(1);
      delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    });
  });

  it("a fitted caption stays put when it is measured again (it used to flip between a small and a large size)", () => {
    // Fake text metrics: each character is half the font size wide, the font is 20px, and the caption line is 450px wide: the 53-character caption needs about 85% of its size.
    resetMeasurer();
    const callbacks: Array<() => void> = [];
    class FakeObserver { constructor(cb: () => void) { callbacks.push(cb); } observe() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => {
      const ctx = { font: "", measureText(t: string) { return { width: t.length * parseFloat(/([\d.]+)px/.exec(ctx.font)![1]!) * 0.5 }; } };
      return ctx;
    }) as never);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.tagName === "FIGCAPTION" ? 450 : 0; });
    vi.spyOn(window, "getComputedStyle").mockImplementation(((el: HTMLElement) => {
      const f = el.style.fontSize; // "calc(5cqw * 0.84)", which jsdom writes out as "calc(4.2cqw)"; no value at all means the normal 5cqw
      const scale = /\* ([\d.]+)\)/.test(f) ? Number(/\* ([\d.]+)\)/.exec(f)![1]) : /([\d.]+)cqw/.test(f) ? Number(/([\d.]+)cqw/.exec(f)![1]) / 5 : 1;
      return { fontStyle: "normal", fontWeight: "400", fontFamily: "x", fontSize: `${20 * scale}px` };
    }) as never);

    const long = show("Metallica: Life Burns Faster Than Light", "2026-10-15", { score: 10, photos: [photo("m1"), photo("m2")] });
    render(<ReviewStory data={{ ...DATA, shows: [long, show("B", "2026-02-10")] }} today={TODAY} />);
    fireEvent.click(screen.getByLabelText("Next slide")); // the slideshow of the best show
    const caption = () => document.querySelector("figcaption")!;
    const seen = () => `${caption().textContent} | ${(caption() as HTMLElement).style.fontSize}`;
    const first = seen();
    expect(caption().textContent).toBe("Metallica: Life Burns Faster Than Light · Oct · 1 / 2"); // fits when shrunk, so nothing is cut
    expect((caption() as HTMLElement).style.fontSize).toMatch(/^calc\((4\.2cqw|5cqw \* 0\.84)\)$/); // 84% (jsdom writes the sum out)
    for (let i = 0; i < 6; i++) { act(() => { callbacks.forEach((cb) => cb()); }); expect(seen()).toBe(first); }
  });

  it("stops on the last slide, and keys and the close button work", () => {
    const close = vi.fn();
    render(<ReviewStory data={DATA} today={TODAY} onClose={close} />);
    const region = screen.getByRole("region", { name: "Recap" });
    for (let i = 0; i < 6; i++) fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(heading()).toBe("That's a wrap");
    tick(60_000);
    expect(heading()).toBe("That's a wrap");
    fireEvent.keyDown(region, { key: "Escape" });
    fireEvent.click(screen.getByLabelText("Close"));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("offers a make-your-own link only on the last slide, and only when asked to", () => {
    const cta = { href: "/", label: "Make your own recap" };
    const { unmount } = render(<ReviewStory data={DATA} today={TODAY} cta={cta} />);
    expect(screen.queryByRole("link", { name: cta.label })).toBeNull();
    const region = screen.getByRole("region", { name: "Recap" });
    for (let i = 0; i < 6; i++) fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(screen.getByRole("link", { name: cta.label }).getAttribute("href")).toBe("/");
    unmount();
    render(<ReviewStory data={DATA} today={TODAY} />);
    for (let i = 0; i < 6; i++) fireEvent.keyDown(screen.getByRole("region", { name: "Recap" }), { key: "ArrowRight" });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("starts paused for people who asked for reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render(<ReviewStory data={DATA} today={TODAY} />);
    tick(30_000);
    expect(heading()).toBe("In 2026 you went to");
    expect(screen.getByLabelText("Play")).toBeTruthy();
  });

  it("a show without photos still gets a scored slide and says nothing about missing pictures", () => {
    render(<ReviewStory data={{ ...DATA, shows: [show("A", "2026-01-10", { score: 8 }), show("B", "2026-02-10")] }} today={TODAY} />);
    fireEvent.click(screen.getByLabelText("Next slide"));
    expect(heading()).toMatch(/Your highest score/);
    expect(document.querySelector("img")).toBeNull();
  });
});
