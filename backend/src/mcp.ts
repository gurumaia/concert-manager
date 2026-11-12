import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { AppError, type Ctx, type Service } from "./domain/service.js";
import { TRIAGE_TABS, countTabs, defaultNewSince, matchesFilters, triageText, type TriageFilters } from "./domain/triage.js";
import { ops } from "./ops.js";

const INSTRUCTIONS = `Show Manager tracks concerts the user might attend.
Typical flow: list_venues, then create events (bulk_create_events after researching/scraping; pass venueId for known venues, or a venue name + address; re-sending a show that exists updates it),
list_events with rsvp='none' to present undecided candidates grouped by date/venue, then set_rsvp for the ones the user picks.
To let the user decide themselves, call show_triage: in hosts that support MCP Apps it renders the Shows page inline (Going / Interested / Skip / Undo save straight to their account); elsewhere it returns a short text summary, so use list_events + set_rsvp instead.
'going' (also used once tickets are bought) puts the show on the user's Google Calendar; connect it first with calendar_connect.
After a show, set_scores records how good each act was: actScores maps act name to 0-10 in 0.5 steps (null clears); use score instead for a show with one act. list_events returns rsvp.actScores / rsvp.score and topScore, the best act's score.
Dates are YYYY-MM-DD and times HH:MM in the venue's local time. Most fields are optional: leave unknown ones out rather than guessing.`;

export const TRIAGE_URI = "ui://show-manager/triage";

export type McpOptions = {
  /** The self-contained triage page (MCP App). Without it show_triage still works and returns only the text summary. */
  triageHtml?: string;
};

export function errorText(e: unknown): string {
  if (e instanceof AppError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

const TriageInput = {
  tab: z.enum(TRIAGE_TABS).optional().describe("Tab to open: to_decide (default), going, interested, past or all"),
  newSince: z.string().datetime({ offset: true }).optional().describe("ISO timestamp: shows added at or after it get the NEW badge and the 'Added this week' section. Default: 7 days ago"),
  genre: z.string().optional().describe("Only this genre (e.g. 'Metal')"),
  venueId: z.string().optional().describe("Only this venue (id from list_venues)"),
  text: z.string().optional().describe("Only shows matching this text (title, lineup, genre, venue, city)"),
};

/** Build a fresh MCP server bound to the authenticated user. */
export function buildMcpServer(svc: Service, ctx: Ctx, opts: McpOptions = {}): McpServer {
  const server = new McpServer({ name: "show-manager", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const o of ops) {
    server.registerTool(
      o.name,
      {
        title: o.title,
        description: o.description,
        inputSchema: o.input.shape,
        annotations: {
          readOnlyHint: !!o.readOnly,
          destructiveHint: !!o.destructive,
          idempotentHint: !!o.readOnly,
          openWorldHint: o.name === "calendar_connect" || o.name.startsWith("calendar_"),
        },
      },
      async (args: unknown) => {
        try {
          const result = await o.run(svc, ctx, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
        }
      },
    );
  }

  // ---- MCP App: the Shows page, inline. The page reads and writes only through list_events / list_venues / set_rsvp / remove_rsvp
  // (bridge -> this server), so auth, RSVP rules and the Calendar push are the ones above. The model only ever gets the short text.
  registerAppTool(
    server,
    "show_triage",
    {
      title: "Show triage",
      description:
        "Show the user their concerts to triage. In hosts with MCP Apps support it renders the Shows page inline, where the user can mark each show Going / Interested / Skip (or Undo) " +
        "and the choice is saved. The text result is only a short summary: counts per tab plus the shows added since `newSince` (date · title · venue · id). " +
        "Use list_events when you need the full data.",
      inputSchema: TriageInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: TRIAGE_URI } },
    },
    async (args: { tab?: TriageFilters["tab"]; newSince?: string; genre?: string; venueId?: string; text?: string }) => {
      try {
        const now = svc.clock();
        const f: TriageFilters = {
          tab: args.tab ?? "to_decide",
          newSince: args.newSince ?? defaultNewSince(now),
          ...(args.genre ? { genre: args.genre } : {}),
          ...(args.venueId ? { venueId: args.venueId } : {}),
          ...(args.text ? { text: args.text } : {}),
        };
        const { events } = await svc.listEvents(ctx, { limit: 10_000 });
        const today = now.toISOString().slice(0, 10);
        const matching = events.filter((e) => matchesFilters(e, f));
        return {
          content: [{ type: "text" as const, text: triageText(events, f, today) }],
          // Small and for the UI only: the resolved filters and the counts. The shows themselves are fetched by the page through the bridge.
          structuredContent: { ...f, counts: countTabs(matching, today) },
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
      }
    },
  );
  if (opts.triageHtml) {
    const html = opts.triageHtml;
    registerAppResource(
      server,
      "Show Manager triage",
      TRIAGE_URI,
      { description: "The Shows page: tabs, filters, and Going / Interested / Skip / Undo on each card.", mimeType: RESOURCE_MIME_TYPE },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: false } } }] }),
    );
  }
  return server;
}

/** Stateless Streamable HTTP: one server + transport per request (fits Lambda). */
export async function handleMcpRequest(svc: Service, ctx: Ctx, req: Request, opts: McpOptions = {}): Promise<Response> {
  const server = buildMcpServer(svc, ctx, opts);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // the response body is already materialised in JSON mode
    void server.close();
  }
}
