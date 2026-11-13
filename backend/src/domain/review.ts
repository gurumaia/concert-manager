import { z } from "zod";
import { DateStr } from "./schemas.js";

/** Which shows a year in review covers: attended shows in a date range, optionally only the ones with certain people. */
export const ReviewRecipe = z.object({
  from: DateStr.describe("First day (YYYY-MM-DD)"),
  to: DateStr.describe("Last day (YYYY-MM-DD)"),
  people: z.array(z.string().trim().min(1)).max(20).optional().describe("Only shows you went to with these people"),
  match: z.enum(["any", "all"]).optional().describe("With several people: shows with any of them (default) or with all of them"),
});
export type ReviewRecipe = z.infer<typeof ReviewRecipe>;

/** A shared link. The link stores only the recipe; the review is computed fresh every time it is opened. */
export type ReviewLink = {
  /** Random and unguessable; it is the whole link. */
  token: string;
  ownerId: string;
  recipe: ReviewRecipe;
  /** Whether companion names are visible to people who open the link. */
  showNames: boolean;
  createdAt: string;
};

export type ReviewPhoto = { id: string; url: string; thumbUrl: string; caption?: string };
export type ReviewShow = {
  date: string;
  title: string;
  genre?: string;
  venue?: { name: string; city?: string };
  lineup: Array<{ name: string; role?: string }>;
  /** The best score of the show (see EventView.topScore). */
  score?: number;
  /** Names of the people you went with. Left out (empty) on a shared link that hides names; see `companionCount`. */
  companions: string[];
  companionCount: number;
  /** Songs played live, each with the act that played it (a song title alone does not say which band). */
  songs: Array<{ name: string; act: string }>;
  photos: ReviewPhoto[];
};
export type ReviewData = {
  recipe: ReviewRecipe;
  owner?: string;
  shows: ReviewShow[];
};

/** Case- and accent-insensitive comparison key for a person's name ("Ana" and "ana " are one person). */
export const personKey = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
