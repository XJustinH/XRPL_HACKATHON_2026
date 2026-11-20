import { XrplServiceError } from "../errors";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Base URL that ticket metadata and images are published under (XRPL-023):
 * TICKET_METADATA_BASE_URL if set, otherwise APP_BASE_URL. In production this must be the
 * app's public https address so wallets and explorers can fetch the metadata.
 */
export function ticketPublicBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env.TICKET_METADATA_BASE_URL?.trim() || env.APP_BASE_URL?.trim() || "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new XrplServiceError("CONFIG_ERROR", `Ticket metadata base URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new XrplServiceError("CONFIG_ERROR", "Ticket metadata base URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new XrplServiceError(
      "CONFIG_ERROR",
      "Ticket metadata base URL must not contain credentials, a query or a fragment",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/** The stable metadata URI written into a ticket's NFT. One per ticket record. */
export function ticketMetadataUrl(baseUrl: string, ticketId: string): string {
  return `${baseUrl}/api/tickets/${encodeURIComponent(ticketId)}/metadata`;
}

/** The generated ticket image, used when the event has no artwork of its own. */
export function ticketImageUrl(baseUrl: string, ticketId: string): string {
  return `${baseUrl}/api/tickets/${encodeURIComponent(ticketId)}/image`;
}

/** False for localhost and private-network addresses, which wallets and explorers cannot reach. */
export function isPubliclyReachable(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOCAL_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".localhost")) return false;
  return !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/** The event's own artwork when it is a usable https URL; otherwise null. */
export function publicArtworkUrl(artworkUrl: string | null | undefined): string | null {
  if (!artworkUrl) return null;
  try {
    return new URL(artworkUrl).protocol === "https:" ? artworkUrl : null;
  } catch {
    return null;
  }
}
