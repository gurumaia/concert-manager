import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { op, setOpTransport } from "../api";
import { EventsPage, type Decision, type Embed } from "../pages/EventsPage";
import type { EventView, VenueRow } from "../types";
import { bridgeTransport, decisionLine, filtersFrom, pageTab, type Filters } from "./bridge";

const DAY_MS = 86_400_000;
/** How long to wait for the tool result before showing the page with default filters (e.g. when opened without a tool call). */
const FILTERS_WAIT_MS = 1500;

/** The Shows page as an MCP App. Everything it reads or writes goes through the host as tool calls. */
export function TriageApp() {
  const [filters, setFilters] = useState<Filters>();
  const [waited, setWaited] = useState(false);
  const decisions = useRef(new Map<string, string>());
  const { app, error: connectError } = useApp({
    appInfo: { name: "Show Manager triage", version: "0.1.0" },
    capabilities: {},
    autoResize: true,
    onAppCreated: (a) => {
      // Handlers go in before connect(), so the first tool result is never missed.
      a.ontoolresult = (r) => { const f = filtersFrom(r.structuredContent); if (f) setFilters(f); };
      a.onhostcontextchanged = (c) => applyTheme(c.theme);
    },
  });

  useEffect(() => {
    document.documentElement.classList.add("mcp-app");
    const t = setTimeout(() => setWaited(true), FILTERS_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!app) return;
    applyTheme(app.getHostContext()?.theme);
    setOpTransport(bridgeTransport(app));
    return () => setOpTransport(undefined);
  }, [app]);

  if (connectError) return <main><p role="alert" className="error">Could not connect to Claude: {connectError.message}</p></main>;
  if (!app) return <main><p className="muted">Loading…</p></main>;
  if (!filters && !waited) return <main><p className="muted">Loading shows…</p></main>;
  return <Loaded app={app} filters={filters ?? {}} decisions={decisions.current} />;
}

function applyTheme(theme: string | undefined) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}

function Loaded({ app, filters, decisions }: { app: App; filters: Filters; decisions: Map<string, string> }) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [e, v] = await Promise.all([
        op<{ events: EventView[] }>("list_events", { limit: 500 }),
        op<VenueRow[]>("list_venues", { includeRetired: true }),
      ]);
      setEvents(e.events); setVenues(v); setError(undefined);
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // After each RSVP change, tell the model what was decided (the host keeps the latest value for the next turn). The model gets one
  // line per show the user has decided in this widget, so several quick clicks are all there, not just the last.
  const onDecision = useCallback((d: Decision) => {
    if (d.to) decisions.set(d.event.id, decisionLine(d.event, d.to));
    else decisions.delete(d.event.id);
    const text = decisions.size
      ? `The user made these RSVP decisions in the Show Manager triage widget (already saved):\n${[...decisions.values()].map((l) => `- ${l}`).join("\n")}`
      : "The user undid their RSVP changes in the Show Manager triage widget; nothing is decided there now.";
    app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined); // not every host accepts it; the RSVP itself is saved
  }, [app, decisions]);

  const embed = useMemo<Embed>(() => {
    const since = filters.newSince ? Date.parse(filters.newSince) : NaN;
    return {
      newSince: Number.isFinite(since) ? since : Date.now() - 7 * DAY_MS,
      initial: { tab: pageTab(filters.tab), genre: filters.genre, venueId: filters.venueId, text: filters.text },
      onDecision,
      openLink: (url) => { void app.openLink({ url }).catch(() => undefined); },
    };
  }, [filters, onDecision, app]);

  return <main id="main"><EventsPage events={events} venues={venues} reload={reload} error={error} loading={loading} embed={embed} /></main>;
}
