// The feed: one page of what changed.

import type { FeedCategory, FeedNote } from "./format.ts";
import type { Http } from "./http.ts";

export const FEED_VERSION = 1;

export type FeedPage = {
  version: number;
  account: string;
  notes: FeedNote[];
  categories: FeedCategory[];
  next: string;
  more: boolean;
  remaining: number;
};

/** What a person can act on, as one plain sentence. */
export class FeedStop extends Error {
  constructor(message: string, readonly reason: "sign-in" | "update" | "later") {
    super(message);
  }
}

export async function fetchPage(
  http: Http,
  url: string,
  token: string,
  after: string,
  version: string,
  limit = 100,
): Promise<FeedPage | "expired"> {
  const res = await http({
    url: `${url}?after=${encodeURIComponent(after)}&limit=${limit}`,
    headers: { Authorization: `Bearer ${token}`, "X-ThoughtFree-Plugin": version },
  });
  switch (res.status) {
    case 200:
      break;
    case 401:
      return "expired";
    case 426:
      throw new FeedStop("Update the ThoughtFree plugin to keep syncing.", "update");
    case 429:
      throw new FeedStop("Too many syncs for now. It will try again later.", "later");
    default:
      throw new FeedStop("ThoughtFree did not answer. It will try again later.", "later");
  }
  const page = res.json as FeedPage;
  // A shape this build cannot read must stop here, before anything is written.
  if (!page || page.version !== FEED_VERSION || !Array.isArray(page.notes)) {
    throw new FeedStop("Update the ThoughtFree plugin to keep syncing.", "update");
  }
  return page;
}
