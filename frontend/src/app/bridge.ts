import type { App } from "@modelcontextprotocol/ext-apps";
import { ApiError } from "../api";

/** The text of a tool result (our tools answer with one JSON text block, or a plain message on errors). */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

/**
 * Operation transport for the MCP App: every call is a tool call made by the host on the page's behalf
 * (app.callServerTool), so authentication, validation, RSVP rules and the Calendar push are the server's own.
 * The page never has a token and never calls an API itself.
 */
export function bridgeTransport(app: Pick<App, "callServerTool">) {
  return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    const result = await app.callServerTool({ name, arguments: input });
    const text = textOf(result as never);
    if (result.isError) throw new ApiError(text || "Request failed", 400);
    try { return JSON.parse(text); } catch { throw new ApiError("Unexpected reply from the server", 502); }
  };
}

export type Filters = { tab?: string; newSince?: string; genre?: string; venueId?: string; text?: string };

/** Filters the tool resolved for this call (structuredContent of show_triage's result). Anything malformed is ignored. */
export function filtersFrom(structured: unknown): Filters | undefined {
  if (!structured || typeof structured !== "object") return undefined;
  const s = structured as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { tab: str(s.tab), newSince: str(s.newSince), genre: str(s.genre), venueId: str(s.venueId), text: str(s.text) };
}

const TAB_FROM_TOOL = { to_decide: "undecided", going: "going", interested: "interested", past: "past", all: "all" } as const;
export const pageTab = (t: string | undefined) => (t && t in TAB_FROM_TOOL ? TAB_FROM_TOOL[t as keyof typeof TAB_FROM_TOOL] : undefined);

/** A decision as one line for the model: "Going: Slayer · 2026-12-17 · Nubank Parque (id abc)". */
export function decisionLine(e: { id: string; title: string; date: string; venue?: { name: string } | null }, status: string): string {
  const label = ({ going: "Going", interested: "Interested", skipped: "Skipped" } as Record<string, string>)[status] ?? status;
  return `${label}: ${e.title} · ${e.date}${e.venue ? ` · ${e.venue.name}` : ""} (id ${e.id})`;
}
