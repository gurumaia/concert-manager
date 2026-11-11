// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTheme, setTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf7f3" /><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#14110f" />';
});
afterEach(() => localStorage.clear());

describe("theme", () => {
  it("defaults to following the system", () => {
    expect(getTheme()).toBe("system");
  });

  it("applies and remembers light and dark", () => {
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(getTheme()).toBe("light");
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"))).toEqual(["#faf7f3", "#faf7f3"]);
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("sm.theme")).toBe("dark");
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"))).toEqual(["#14110f", "#14110f"]);
  });

  it("system removes the override again", () => {
    setTheme("dark");
    setTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("sm.theme")).toBeNull();
    expect(getTheme()).toBe("system");
    // each OS scheme gets its own bar colour back
    expect([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"))).toEqual(["#faf7f3", "#14110f"]);
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem("sm.theme", "purple");
    expect(getTheme()).toBe("system");
  });
});
