# Roadmap

Things we want to build later, in rough priority order. Move an item to "Done" when it ships.

## Next

### Recap as a video for social media
A downloadable PNG is not useful on its own. The recap only travels on social media (Instagram stories, WhatsApp status, TikTok) if it is a **video**.

- Export the recap story as a vertical video (9:16, around 1080x1920, MP4) that the owner can save and post.
- The story is a React tap-through (`frontend/src/components/ReviewStory.tsx`) with fixed slide timing (`slideDuration` in `frontend/src/review.ts`), so a render can step through the same deck.
- Options to evaluate:
  1. Render in the browser: draw each slide to a canvas and encode with WebCodecs + MediaRecorder. No server cost, but browser support (iPhone Safari) is the risk.
  2. Render on the server: headless Chromium (Lambda container or Fargate task) plays the public recap page and records it; ffmpeg encodes. Works everywhere, costs compute per export.
- Add music? Needs licensing, so start silent or let the owner add sound inside the social app.
- Keep the "show names of people" privacy choice and the photo rules (private photos are never included unless made public).

### Final name for the feature
The feature is now called **Recap**. Revisit the name before launch (nav label, page titles, link-preview text in `frontend/vite.config.ts`).

## Later

- A link-preview image that shows the owner's stats and a cover photo (today the preview is the Show Manager logo).
- Run the recap test with heavy concert-goers outside our circle (December), and decide in January whether to invest in show discovery.

## Done

- Recap share page: rename from "Year in review", link preview (logo) for WhatsApp/iMessage/Slack, and a "Make your own recap" button on the last slide.
