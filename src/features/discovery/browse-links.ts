/**
 * Links from an event into a filtered search (XRPL-060).
 *
 * Browsing by venue or organiser reuses the public search rather than adding a
 * second listing path, so the published-only rule is enforced in exactly one
 * place and a draft cannot leak through a route that forgot to check.
 */

/** A search scoped to one venue. */
export function venueBrowseHref(venue: string, city?: string): string {
  const params = new URLSearchParams();
  const trimmedVenue = venue.trim();
  if (trimmedVenue) params.set("venue", trimmedVenue);
  // The city narrows same-named venues in different places.
  const trimmedCity = city?.trim();
  if (trimmedCity) params.set("city", trimmedCity);
  return `/search?${params.toString()}`;
}

/** A search scoped to one city. */
export function cityBrowseHref(city: string): string {
  const params = new URLSearchParams();
  const trimmed = city.trim();
  if (trimmed) params.set("city", trimmed);
  return `/search?${params.toString()}`;
}

/**
 * A search scoped to one organiser.
 *
 * The storefront at `/sellers/:id` is the richer landing page; this is for
 * "everything by this organiser" within the search UI, where the filter can
 * then be combined with a date or city.
 */
export function organiserBrowseHref(sellerId: string): string {
  return `/search?sellerId=${encodeURIComponent(sellerId)}`;
}
