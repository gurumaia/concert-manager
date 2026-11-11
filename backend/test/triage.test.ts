import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { countTabs, inTab, isNewSince, triageText, type TriageEvent } from "../src/domain/triage.js";
import { devAuthenticator } from "../src/infra/auth.js";
import type { Config } from "../src/infra/config.js";
import { FakeIdentity, friedman, setup } from "./helpers.js";

const TODAY = "2026-11-10";
const ev = (id: string, date: string, createdAt: string, extra: Partial<TriageEvent> = {}): TriageEvent =>
  ({ id, title: `Show ${id}`, date, createdAt, updatedAt: createdAt, venue: null, rsvp: null, ...extra }) as TriageEvent;
const rsvp = (status: "going" | "interested" | "skipped" | "attended") => ({ eventId: "x", status, sharedWith: [], createdAt: "", updatedAt: "" });

describe("triage tabs", () => {
  it("follows the Shows page rules", () => {
    const list = [
      ev("a", "2026-12-01", "2026-11-09T00:00:00Z"),
      ev("b", "2026-12-02", "2026-11-09T00:00:00Z", { rsvp: rsvp("going") }),
      ev("c", "2026-12-03", "2026-11-09T00:00:00Z", { rsvp: rsvp("interested") }),
      ev("d", "2026-12-04", "2026-11-09T00:00:00Z", { rsvp: rsvp("skipped") }),
      ev("e", "2026-11-01", "2026-10-01T00:00:00Z", { rsvp: rsvp("going") }),
      ev("f", TODAY, "2026-11-09T00:00:00Z"),
    ];
    expect(countTabs(list, TODAY)).toEqual({ to_decide: 2, going: 1, interested: 1, past: 1, all: 6 });
    expect(inTab(list[3]!, "to_decide", TODAY)).toBe(false); // skipped leaves To decide...
    expect(inTab(list[3]!, "all", TODAY)).toBe(true); // ...but stays under All
  });

  it("treats newSince as an inclusive lower bound and ignores unparseable dates", () => {
    expect(isNewSince("2026-11-03T12:00:00.000Z", "2026-11-03T12:00:00.000Z")).toBe(true);
    expect(isNewSince("2026-11-03T11:59:59.999Z", "2026-11-03T12:00:00.000Z")).toBe(false);
    expect(isNewSince("", "2026-11-03T12:00:00.000Z")).toBe(false);
  });

  it("keeps the text under 2 KB however many shows are new", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      ev(`id-${"x".repeat(30)}-${i}`, "2026-12-01", "2026-11-09T00:00:00Z", { title: "T".repeat(200), venue: { id: "v", name: "V".repeat(200), createdAt: "", updatedAt: "" } }));
    const text = triageText(many, { tab: "to_decide", newSince: "2026-11-03T00:00:00.000Z" }, TODAY);
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
    expect(text).toMatch(/…and \d+ more\./);
    expect(text).toContain("to decide 400");
  });
});

const cfg: Config = {
  tableName: "t", region: "us-east-1", userPoolId: "p", cognitoClientId: "client123",
  cognitoDomain: "https://auth.example.com", publicBaseUrl: "https://shows.example.com", devAuth: true,
};

async function connect(triageHtml?: string) {
  const s = await setup();
  const app = createApp({ cfg, svc: s.svc, authenticate: devAuthenticator, repo: s.repo, encryptor: s.encryptor, idp: new FakeIdentity(), triageHtml });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { "x-dev-user": "u1" } },
    fetch: ((url: string | URL, init?: RequestInit) => app.request(String(url), init as RequestInit)) as typeof fetch,
  }));
  return { ...s, client };
}
const textOf = (r: any) => (r.content as Array<{ text: string }>)[0]!.text;

describe("show_triage MCP App", () => {
  it("is linked to the ui:// resource, and the resource serves the page as an MCP App", async () => {
    const { client } = await connect("<html>page</html>");
    const tool = (await client.listTools()).tools.find((t) => t.name === "show_triage")!;
    expect((tool._meta as any).ui.resourceUri).toBe("ui://show-manager/triage");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const res = await client.readResource({ uri: "ui://show-manager/triage" });
    expect(res.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app", text: "<html>page</html>" });
  });

  it("returns a short text with counts and one line per NEW show, with the full data kept out of it", async () => {
    const { client, svc, me } = await connect("<html/>");
    // The service clock is 2026-11-10T12:00Z: this one is added "now", so it is NEW with the default 7-day window.
    const fresh = await svc.createEvent(me, { ...friedman, date: "2026-12-20", title: "Fresh Metal Show", genre: "Metal" });
    await svc.createEvent(me, { title: "Another", date: "2026-12-21" });
    const r = await client.callTool({ name: "show_triage", arguments: {} });
    const text = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
    expect(text).toContain("to decide 2");
    expect(text).toContain(`2026-12-20 · Fresh Metal Show · Tokio Marine Hall · ${fresh.event.id}`);
    // nothing but the summary: no JSON dump of events, no lineup, no tiers
    expect(text).not.toContain("lineup");
    expect(text).not.toContain("Pista");
    expect((r.structuredContent as any).tab).toBe("to_decide");
    expect((r.structuredContent as any).newSince).toBe("2026-11-03T12:00:00.000Z");
    expect(JSON.stringify(r.structuredContent)).not.toContain("Fresh Metal Show");
  });

  it("applies tab, newSince, genre, venueId and text", async () => {
    const { client, svc, me } = await connect();
    const a = await svc.createEvent(me, { ...friedman, date: "2026-12-20", genre: "Metal" });
    const b = await svc.createEvent(me, { title: "Jazz Night", date: "2026-12-22", genre: "Jazz" });
    await svc.setRsvp(me, b.event.id, { status: "going" });
    const going = textOf(await client.callTool({ name: "show_triage", arguments: { tab: "going" } }));
    expect(going).toContain("Jazz Night");
    expect(going).not.toContain("Marty Friedman");
    const metal = textOf(await client.callTool({ name: "show_triage", arguments: { genre: "metal", tab: "all" } }));
    expect(metal).toContain("all 1");
    expect(metal).toContain(a.event.id);
    const byVenue = textOf(await client.callTool({ name: "show_triage", arguments: { venueId: a.event.venueId, tab: "all" } }));
    expect(byVenue).toContain("all 1");
    expect(textOf(await client.callTool({ name: "show_triage", arguments: { text: "jazz", tab: "all" } }))).toContain("all 1");
    const future = textOf(await client.callTool({ name: "show_triage", arguments: { newSince: "2027-01-01T00:00:00Z" } }));
    expect(future).toMatch(/Nothing new since 2027-01-01/);
    const bad = await client.callTool({ name: "show_triage", arguments: { newSince: "yesterday" } });
    expect(bad.isError).toBe(true);
  });

  it("still gives the text summary when no page is bundled (hosts without MCP Apps get only this)", async () => {
    const { client, svc, me } = await connect(undefined);
    await svc.createEvent(me, { title: "Solo", date: "2026-12-20" });
    expect(textOf(await client.callTool({ name: "show_triage", arguments: {} }))).toContain("Solo");
  });

  it("saves RSVPs through the ordinary tools, which the page calls over the bridge", async () => {
    const { client, svc, me } = await connect("<html/>");
    const e = await svc.createEvent(me, { title: "Rsvp Me", date: "2026-12-20" });
    const set = await client.callTool({ name: "set_rsvp", arguments: { eventId: e.event.id, status: "going" } });
    expect(JSON.parse(textOf(set)).rsvp.status).toBe("going");
    expect(textOf(await client.callTool({ name: "show_triage", arguments: { tab: "going" } }))).toContain("going 1");
    await client.callTool({ name: "remove_rsvp", arguments: { eventId: e.event.id } });
    expect(textOf(await client.callTool({ name: "show_triage", arguments: {} }))).toContain("to decide 1");
  });
});

describe("re-sending a show keeps createdAt (so old shows do not look NEW)", () => {
  const sendOne = async (s: Awaited<ReturnType<typeof setup>>, input: any, mode: "create" | "bulk" = "create") => {
    if (mode === "bulk") return (await s.svc.bulkCreateEvents(s.me, [input])).updated[0]?.event;
    return (await s.svc.createEvent(s.me, input)).event;
  };

  it("create_event upsert with changes", async () => {
    const s = await setup();
    const first = (await s.svc.createEvent(s.me, friedman)).event;
    const later = new Date("2026-12-01T00:00:00Z");
    (s.svc as any).d.now = () => later;
    const again = await sendOne(s, { ...friedman, genre: "Metal", startTime: "22:00" });
    expect(again!.id).toBe(first.id);
    expect(again!.startTime).toBe("22:00");
    expect(again!.createdAt).toBe(first.createdAt);
    expect(again!.updatedAt).not.toBe(first.updatedAt);
  });

  it("bulk_create_events upsert with changes, and unchanged re-sends", async () => {
    const s = await setup();
    const first = (await s.svc.createEvent(s.me, friedman)).event;
    (s.svc as any).d.now = () => new Date("2026-12-01T00:00:00Z");
    const changed = await sendOne(s, { ...friedman, notes: "n" }, "bulk");
    expect(changed!.createdAt).toBe(first.createdAt);
    await s.svc.bulkCreateEvents(s.me, [friedman]);
    expect((await s.svc.getEvent(s.me, first.id)).createdAt).toBe(first.createdAt);
  });

  it("a show that moved venue keeps its createdAt", async () => {
    const s = await setup();
    const first = (await s.svc.createEvent(s.me, { ...friedman, date: "2026-12-20" })).event;
    (s.svc as any).d.now = () => new Date("2026-12-01T00:00:00Z");
    const moved = await s.svc.createEvent(s.me, { title: friedman.title, date: "2026-12-20", venue: { name: "Other Hall", city: "São Paulo" } });
    expect(moved.event.id).toBe(first.id);
    expect(moved.event.venue?.name).toBe("Other Hall");
    expect(moved.event.createdAt).toBe(first.createdAt);
  });

  it("ignores a createdAt/id smuggled into the input, both over MCP and in the service", async () => {
    const { client, svc, me } = await connect();
    const first = (await svc.createEvent(me, { title: "Keep", date: "2026-12-20" })).event;
    (svc as any).d.now = () => new Date("2026-12-01T00:00:00Z");
    await client.callTool({ name: "create_event", arguments: { title: "Keep", date: "2026-12-20", genre: "X", createdAt: "2026-12-01T00:00:00Z", id: "zzz" } });
    await svc.createEvent(me, { title: "Keep", date: "2026-12-20", genre: "Y", createdAt: "2026-12-01T00:00:00Z", id: "zzz" } as any);
    const got = await svc.getEvent(me, first.id);
    expect(got.createdAt).toBe(first.createdAt);
    expect(got.genre).toBe("Y");
    expect((await svc.listEvents(me)).total).toBe(1);
  });
});
