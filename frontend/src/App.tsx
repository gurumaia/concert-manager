import { useCallback, useEffect, useState } from "react";
import { op } from "./api";
import {
  clearSession, completeGoogleLogin, completeMcpAuthorization, getConfig, isSignedIn, pendingAuthreq, rememberAuthreq, rememberReturnTo,
  setDevUser, takeReturnTo, type AppConfig,
} from "./auth";
import { LoginPage } from "./pages/LoginPage";
import { useRoute } from "./router";
import { EventsPage } from "./pages/EventsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SharedPage } from "./pages/SharedPage";
import { VenuesPage } from "./pages/VenuesPage";
import type { EventView, VenueRow } from "./types";

const NAV = [
  { path: "/", label: "Shows" },
  { path: "/history", label: "History" },
  { path: "/shared", label: "Shared with me" },
  { path: "/venues", label: "Venues" },
  { path: "/settings", label: "Settings" },
];

export function App() {
  const [path, go] = useRoute();
  const [cfg, setCfg] = useState<AppConfig>();
  const [authError, setAuthError] = useState<string>();
  const [, rerender] = useState(0);

  useEffect(() => { getConfig().then(setCfg).catch(() => setAuthError("Cannot reach the server")); }, []);

  // /login?authreq=... : Claude is asking the user to sign in; keep the request while they log in (also across the Google redirect).
  useEffect(() => {
    const h = new URLSearchParams(location.search).get("authreq");
    if (path.startsWith("/login") && h) rememberAuthreq(h);
  }, [path]);

  // Where to go once signed in: back to Claude if it asked, otherwise to the page the user wanted.
  const signedIn = useCallback(async () => {
    const h = pendingAuthreq();
    if (h) {
      try { location.assign(await completeMcpAuthorization(h)); return; }
      catch (e) { setAuthError((e as Error).message); }
    }
    const back = takeReturnTo();
    history.replaceState(null, "", back);
    go(back);
    rerender((n) => n + 1);
  }, [go]);

  // A signed-in user who lands on /login: finish straight away.
  useEffect(() => {
    if (cfg && !cfg.devAuth && path.startsWith("/login") && isSignedIn()) void signedIn();
  }, [cfg, path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Google redirect landing.
  useEffect(() => {
    if (!path.startsWith("/auth/callback")) return;
    const p = new URLSearchParams(location.search);
    const code = p.get("code");
    if (!code) { setAuthError(p.get("error_description") ?? "Sign-in was cancelled"); return; }
    completeGoogleLogin(code).then(signedIn).catch((e) => setAuthError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) return <Centered>{authError ? <p role="alert" className="error">{authError}</p> : <p className="muted">Loading…</p>}</Centered>;
  if (path.startsWith("/auth/callback")) {
    return <Centered>{authError ? <><p role="alert" className="error">{authError}</p><a className="btn primary" href="/login">Back to sign in</a></> : <p>Signing you in…</p>}</Centered>;
  }
  if (!cfg.devAuth && (!isSignedIn() || path.startsWith("/login"))) {
    if (!path.startsWith("/login")) rememberReturnTo(path);
    // Already signed in and sent to /login (e.g. by Claude): the effect above completes it.
    if (isSignedIn() && !authError) return <Centered><p className="muted">Signing you in…</p></Centered>;
    return (
      <>
        {authError && <p role="alert" className="error banner">{authError}</p>}
        <LoginPage cfg={cfg} forClaude={!!pendingAuthreq()} onSignedIn={() => void signedIn()} />
      </>
    );
  }
  return <Shell path={path} go={go} cfg={cfg} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}

function Shell({ path, go, cfg }: { path: string; go: (to: string) => void; cfg: AppConfig }) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [me, setMe] = useState<{ email?: string; name?: string }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [e, v] = await Promise.all([
        op<{ events: EventView[] }>("list_events", { limit: 500 }),
        op<VenueRow[]>("list_venues", { includeRetired: true }),
      ]);
      setEvents(e.events); setVenues(v); setError(undefined);
    } catch (err) {
      setError((err as Error).message);
      if ((err as { status?: number }).status === 401) { clearSession(); location.assign("/login"); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void reload(); op<{ email?: string; name?: string }>("whoami").then(setMe).catch(() => undefined); }, [reload]);

  const route = path.split("?")[0]!;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}><span className="logo" aria-hidden="true">♪</span> Show Manager</a>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <a key={n.path} href={n.path} aria-current={route === n.path ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(n.path); }}>{n.label}</a>
          ))}
        </nav>
        {cfg.devAuth && <DevUser />}
      </header>
      <main id="main">
        {route === "/" && <EventsPage events={events} venues={venues} reload={reload} error={error} loading={loading} />}
        {route === "/history" && <HistoryPage venues={venues} reload={reload} />}
        {route === "/shared" && <SharedPage />}
        {route === "/venues" && <VenuesPage venues={venues} reload={reload} />}
        {route === "/settings" && <SettingsPage me={me} />}
        {!NAV.some((n) => n.path === route) && <p>Page not found. <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }}>Back to shows</a></p>}
      </main>
    </>
  );
}

function DevUser() {
  return (
    <button className="btn small ghost" title="Local development only" onClick={() => { const u = prompt("Dev user"); if (u) { setDevUser(u); location.reload(); } }}>dev user</button>
  );
}
