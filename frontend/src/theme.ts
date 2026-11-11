// Light / dark / follow-the-system. The choice lives in localStorage; index.html applies it before first paint.
export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "sm.theme";
export const THEMES: Theme[] = ["system", "light", "dark"];

export function getTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

const BAR: Record<"light" | "dark", string> = { light: "#faf7f3", dark: "#14110f" };

/** Apply and remember a theme. "system" removes the override so the OS setting decides again. */
export function setTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") {
    localStorage.removeItem(THEME_KEY);
    delete root.dataset.theme;
  } else {
    localStorage.setItem(THEME_KEY, t);
    root.dataset.theme = t;
  }
  // Keep the mobile browser bar in step with the page: the chosen theme, or each OS scheme's own colour when following the system.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const own = m.getAttribute("media")?.includes("dark") ? "dark" : "light";
    m.setAttribute("content", BAR[t === "system" ? own : t]);
  });
}
