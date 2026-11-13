import { op } from "./api";
import type { EventView } from "./types";

const PAGE = 500; // list_events returns at most 500 at a time

export async function loadAttended(): Promise<EventView[]> {
  const all: EventView[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const r = await op<{ total: number; events: EventView[] }>("list_events", { rsvp: "attended", sort: "desc", limit: PAGE, offset });
    all.push(...r.events);
    if (offset + PAGE >= r.total || !r.events.length) return all;
  }
}
