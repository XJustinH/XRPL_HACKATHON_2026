import { EVENT_CATEGORY_LABELS, type EventCategory, type EventView } from "@/contracts";

/**
 * Ranking upcoming events by declared interests and chosen city (XRPL-089).
 *
 * Deliberately transparent and deterministic, as the issue asks: every event
 * carries the reasons it was ranked up, the weights are constants in this file,
 * and the same inputs always produce the same order. There is no opaque model
 * and no behavioural tracking.
 *
 * **Ranking only ever reorders.** No event is filtered out or hidden because of
 * a preference, so the full list stays reachable and a customer with no
 * preferences sees exactly what everyone else sees.
 *
 * Location is the city a customer typed into their preferences, compared with
 * the city on the event. Nothing here reads device geolocation, and no
 * coordinate ever enters the calculation.
 */

/**
 * A followed organiser is the strongest signal (XRPL-090). Following is a
 * deliberate choice about a specific account, so it outranks a city match and a
 * keyword guess about the topic.
 */
const FOLLOWED_WEIGHT = 8;
/** City match is weighted above a single interest: being able to attend matters more. */
const CITY_WEIGHT = 5;
const INTEREST_WEIGHT = 2;
/** One interest can contribute at most once, so a keyword-stuffed title cannot dominate. */
const MAX_INTEREST_MATCHES = 3;

/**
 * Words that suggest a category, used to match an interest against an event.
 *
 * **Fallback only.** An event whose seller chose a category (`Event.category`)
 * is matched on that exactly. These words are used only for events without one,
 * matched against the title and description. That is a weaker signal, so it is
 * labelled as a guess in the UI.
 */
const CATEGORY_KEYWORDS: Record<EventCategory, readonly string[]> = {
  MUSIC: ["music", "live", "band", "gig", "concert", "acoustic", "singer", "tour"],
  CLUB: ["club", "dj", "techno", "house", "rave", "disco", "late"],
  COMEDY: ["comedy", "comedian", "stand-up", "standup", "improv", "sketch"],
  THEATRE: ["theatre", "theater", "play", "drama", "musical", "stage"],
  FILM: ["film", "cinema", "screening", "documentary", "movie", "premiere"],
  ARTS: ["art", "gallery", "exhibition", "museum", "sculpture", "painting"],
  SPORT: ["sport", "match", "game", "race", "tournament", "league", "cup"],
  FOOD: ["food", "drink", "tasting", "dinner", "market", "beer", "wine", "supper"],
  COMMUNITY: ["community", "meetup", "fundraiser", "charity", "volunteer", "local"],
  TALKS: ["talk", "workshop", "lecture", "panel", "seminar", "conference", "class"],
  FAMILY: ["family", "kids", "children", "all ages", "child-friendly"],
  OTHER: [],
};

export type RankingSignals = {
  interests: readonly EventCategory[];
  /** City the customer typed. Never a coordinate or a device-derived place. */
  city: string | null;
  /** Seller ids the customer follows (XRPL-061), promoted by XRPL-090. */
  followedSellerIds?: readonly string[];
};

export type ScoredEvent = {
  event: EventView;
  score: number;
  /** Plain-language reasons, shown to the customer so the order is explainable. */
  reasons: string[];
};

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * How an event matches an interest: its declared category, a guess from its words
 * when it has no category, or not at all.
 */
function matchesCategory(event: EventView, category: EventCategory): "DECLARED" | "GUESSED" | null {
  if (event.category) return event.category === category ? "DECLARED" : null;
  const words = CATEGORY_KEYWORDS[category];
  if (words.length === 0) return null;
  const haystack = `${normalise(event.title)} ${normalise(event.description)}`;
  return words.some((word) => haystack.includes(word)) ? "GUESSED" : null;
}

export function scoreEvent(event: EventView, signals: RankingSignals): ScoredEvent {
  const reasons: string[] = [];
  let score = 0;

  // Named rather than generic, so the reason is worth reading.
  if (signals.followedSellerIds?.includes(event.seller.id)) {
    score += FOLLOWED_WEIGHT;
    reasons.push(`You follow ${event.seller.displayName}`);
  }

  const city = signals.city ? normalise(signals.city) : null;
  if (city && normalise(event.city) === city) {
    score += CITY_WEIGHT;
    reasons.push(`In ${event.city}`);
  }

  let matched = 0;
  for (const interest of signals.interests) {
    if (matched >= MAX_INTEREST_MATCHES) break;
    const match = matchesCategory(event, interest);
    if (!match) continue;
    score += INTEREST_WEIGHT;
    matched += 1;
    // "Looks like" only for a text guess; a declared category is stated as a fact.
    reasons.push(
      match === "DECLARED"
        ? `${EVENT_CATEGORY_LABELS[interest]}, one of your interests`
        : `Looks like ${EVENT_CATEGORY_LABELS[interest].toLowerCase()}`,
    );
  }

  return { event, score, reasons };
}

/**
 * Reorders events by relevance, highest first.
 *
 * The sort is stable, so events with equal scores keep the order they arrived
 * in — which is soonest-first from the listing query. That makes the result
 * deterministic and keeps date as the implicit tiebreak.
 *
 * Returns every event it was given. Nothing is dropped.
 */
export function rankEvents(
  events: readonly EventView[],
  signals: RankingSignals,
): ScoredEvent[] {
  const scored = events.map((event) => scoreEvent(event, signals));
  // Array.prototype.sort is stable in every supported engine, so equal scores
  // preserve the incoming soonest-first order.
  return [...scored].sort((a, b) => b.score - a.score);
}

/** True when there is anything to rank by, so the UI can skip the explanation. */
export function hasRankingSignals(signals: RankingSignals): boolean {
  return (
    signals.interests.length > 0 ||
    (signals.city?.trim() ?? "") !== "" ||
    (signals.followedSellerIds?.length ?? 0) > 0
  );
}
