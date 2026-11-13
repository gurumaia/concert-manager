import { useEffect, useState } from "react";
import { ReviewStory } from "../components/ReviewStory";
import type { ReviewData } from "../types";

/** A shared year in review (/r/<token>): no sign-in, no app chrome, kept out of search engines. */
export function PublicReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData>();
  const [state, setState] = useState<"loading" | "missing" | "error" | "ready">("loading");

  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "robots"; m.content = "noindex, nofollow";
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`/api/public/review/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        if (!live) return;
        if (r.status === 404) return setState("missing");
        const j = await r.json();
        if (!r.ok || !j.ok) return setState("error");
        setData(j.result); setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => { live = false; };
  }, [token]);

  return (
    <main className="rv-public">
      {state === "loading" && <p className="rv-public-msg">Loading…</p>}
      {state === "missing" && <p className="rv-public-msg" role="alert">This link is not available. It may have been turned off by its owner.</p>}
      {state === "error" && <p className="rv-public-msg" role="alert">Could not load this page. Please try again in a moment.</p>}
      {state === "ready" && data && (data.shows.length ? <ReviewStory data={data} /> : <p className="rv-public-msg">Nothing to show here yet.</p>)}
    </main>
  );
}
