// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  isPubliclyReachable,
  publicArtworkUrl,
  ticketImageUrl,
  ticketMetadataUrl,
  ticketPublicBaseUrl,
} from "../urls";

const TICKET_ID = "7a1c3b9e-2f4d-4c6a-9b8e-1d2f3a4b5c6d";

describe("ticketPublicBaseUrl", () => {
  it("prefers TICKET_METADATA_BASE_URL, then APP_BASE_URL, without a trailing slash", () => {
    expect(
      ticketPublicBaseUrl({
        TICKET_METADATA_BASE_URL: "https://tickets.example/",
        APP_BASE_URL: "http://localhost:3000",
      }),
    ).toBe("https://tickets.example");
    expect(ticketPublicBaseUrl({ APP_BASE_URL: "https://app.example/base/" })).toBe(
      "https://app.example/base",
    );
    expect(ticketPublicBaseUrl({})).toBe("http://localhost:3000");
  });

  it.each(["not a url", "ftp://files.example", "https://user:pw@app.example", "https://app.example/?x=1"])(
    "rejects %s",
    (value) => {
      expect(() => ticketPublicBaseUrl({ TICKET_METADATA_BASE_URL: value })).toThrow(
        /Ticket metadata base URL/,
      );
    },
  );
});

describe("ticket URLs", () => {
  it("builds one stable metadata URL and image URL per ticket", () => {
    expect(ticketMetadataUrl("https://app.example", TICKET_ID)).toBe(
      `https://app.example/api/tickets/${TICKET_ID}/metadata`,
    );
    expect(ticketImageUrl("https://app.example", TICKET_ID)).toBe(
      `https://app.example/api/tickets/${TICKET_ID}/image`,
    );
  });

  it.each([
    ["https://app.example/api/tickets/x/metadata", true],
    ["http://localhost:3000/api/tickets/x/metadata", false],
    ["http://127.0.0.1:3000/x", false],
    ["http://192.168.1.20/x", false],
    ["http://my-laptop.local/x", false],
  ])("isPubliclyReachable(%s) -> %s", (url, reachable) => {
    expect(isPubliclyReachable(url)).toBe(reachable);
  });

  it("uses event artwork only when it is an https URL", () => {
    expect(publicArtworkUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(publicArtworkUrl("http://cdn.example/a.png")).toBeNull();
    expect(publicArtworkUrl("javascript:alert(1)")).toBeNull();
    expect(publicArtworkUrl(null)).toBeNull();
  });
});
