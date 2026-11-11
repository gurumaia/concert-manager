import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AppError, type Ctx, type Service } from "./domain/service.js";
import { ops } from "./ops.js";

const INSTRUCTIONS = `Show Manager tracks concerts the user might attend.
Typical flow: list_venues, then create events (bulk_create_events after researching/scraping; pass venueId for known venues, or a venue name + address; re-sending a show that exists updates it),
list_events with rsvp='none' to present undecided candidates grouped by date/venue, then set_rsvp for the ones the user picks.
'going' (also used once tickets are bought) puts the show on the user's Google Calendar; connect it first with calendar_connect.
Dates are YYYY-MM-DD and times HH:MM in the venue's local time. Most fields are optional: leave unknown ones out rather than guessing.`;

export function errorText(e: unknown): string {
  if (e instanceof AppError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Build a fresh MCP server bound to the authenticated user. */
export function buildMcpServer(svc: Service, ctx: Ctx): McpServer {
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
  return server;
}

/** Stateless Streamable HTTP: one server + transport per request (fits Lambda). */
export async function handleMcpRequest(svc: Service, ctx: Ctx, req: Request): Promise<Response> {
  const server = buildMcpServer(svc, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // the response body is already materialised in JSON mode
    void server.close();
  }
}
