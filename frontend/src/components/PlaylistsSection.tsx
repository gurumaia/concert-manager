import type { EventView } from "../types";

/** How each streaming service is labelled. A service not listed here still shows, with its own name and a neutral badge. */
export const SERVICES: Record<string, { label: string; color: string }> = {
  spotify: { label: "Spotify", color: "#1db954" },
};

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export const serviceInfo = (service: string) => SERVICES[service] ?? { label: service.charAt(0).toUpperCase() + service.slice(1), color: "var(--muted)" };

type Playlist = NonNullable<EventView["playlists"]>[number];

/** Playlists per act, in lineup order. Acts without a playlist are listed too (`playlists` empty); playlists of acts no longer in the lineup come last. */
export function playlistGroups(event: EventView): Array<{ act: string; playlists: Playlist[] }> {
  const acts = event.lineup?.length ? event.lineup.map((a) => a.name) : [event.title];
  const all = event.playlists ?? [];
  const groups = acts.map((act) => ({ act, playlists: all.filter((p) => norm(p.act) === norm(act)) }));
  for (const p of all) {
    if (acts.some((a) => norm(a) === norm(p.act))) continue;
    const g = groups.find((x) => norm(x.act) === norm(p.act));
    if (g) g.playlists.push(p); else groups.push({ act: p.act, playlists: [p] });
  }
  return groups;
}

function Badge({ service }: { service: string }) {
  const { color } = serviceInfo(service);
  return (
    <span className="pl-badge" style={{ background: color }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 3v11.6A3.5 3.5 0 1 0 11 18V8h6V3H9z" /></svg>
    </span>
  );
}

/**
 * Playlists a client built for the acts of a show (through the MCP tools), one line per streaming service.
 * Shown whenever there is one, and for a show I am going to, as a hint of what is missing.
 */
export function PlaylistsSection({ event, readOnly }: { event: EventView; readOnly?: boolean }) {
  const has = (event.playlists?.length ?? 0) > 0;
  const hint = !readOnly && event.rsvp?.status === "going" && !event.past;
  if (!has && !hint) return null;
  const groups = playlistGroups(event);

  return (
    <section aria-labelledby="playlists-h" className="playlists-section">
      <h3 id="playlists-h">Playlists</h3>
      {groups.map((g) => g.playlists.length ? (
        <div key={g.act} className="pl-act">
          <b>{g.act}</b>
          {g.playlists.map((p) => {
            const { label } = serviceInfo(p.service);
            return (
              <div key={p.service} className="pl-line">
                <Badge service={p.service} />
                <div className="pl-text">
                  <b>{p.title ?? `${g.act} on ${label}`}</b>
                  <span className="muted small">{label}{p.trackCount ? ` · ${p.trackCount} songs` : ""}</span>
                </div>
                <a className="btn small" href={p.url} target="_blank" rel="noreferrer" aria-label={`Open ${p.title ?? g.act} on ${label}`}>Open ↗</a>
              </div>
            );
          })}
        </div>
      ) : !readOnly && (
        <p key={g.act} className="pl-empty muted small"><b>{g.act}</b>: no playlist yet. Ask your assistant to build one from their recent setlists.</p>
      ))}
    </section>
  );
}
