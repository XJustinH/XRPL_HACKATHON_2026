import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpUrl, OptionalHttpUrl, safeExternalUrl } from "./common";
import { EventDraftInput, SellerProfilePatch, SocialLink } from "./events";

/**
 * User-supplied URLs are rendered into anchors and image sources on public
 * pages, so a scheme other than http(s) is an execution vector, not a typo.
 *
 * `z.url()` on its own accepts every one of the dangerous values below — these
 * tests exist to make sure nothing silently reverts to it.
 */

const DANGEROUS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "javascript:alert(document.cookie)",
  "  javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "about:blank",
  "blob:https://example.com/abc",
];

const SAFE = [
  "https://example.com",
  "http://example.com",
  "https://example.com/path?q=1#frag",
  "https://sub.example.co.uk/a/b",
  "http://localhost:3000",
];

describe("the plain zod url check is not enough", () => {
  it("accepts dangerous schemes, which is why HttpUrl exists", () => {
    // Guard against anyone "simplifying" HttpUrl back to z.url().
    const permissive = z.url();
    expect(permissive.safeParse("javascript:alert(1)").success).toBe(true);
    expect(HttpUrl.safeParse("javascript:alert(1)").success).toBe(false);
  });
});

describe("HttpUrl", () => {
  it("accepts http and https", () => {
    for (const url of SAFE) {
      expect(HttpUrl.safeParse(url).success, `${url} must be accepted`).toBe(true);
    }
  });

  it("rejects every non-http scheme", () => {
    for (const url of DANGEROUS) {
      expect(HttpUrl.safeParse(url).success, `${url} must be rejected`).toBe(false);
    }
  });

  it("rejects values that are not URLs at all", () => {
    for (const url of ["", "   ", "example.com", "not a url", "//example.com"]) {
      expect(HttpUrl.safeParse(url).success, `${url} must be rejected`).toBe(false);
    }
  });

  it("explains the rule in the message", () => {
    const result = HttpUrl.safeParse("javascript:alert(1)");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/http/i);
    }
  });
});

describe("OptionalHttpUrl", () => {
  it("treats an empty string as cleared", () => {
    expect(OptionalHttpUrl.safeParse("").success).toBe(true);
  });

  it("still rejects a dangerous scheme", () => {
    expect(OptionalHttpUrl.safeParse("javascript:alert(1)").success).toBe(false);
  });
});

describe("every user-supplied URL field uses the restricted type", () => {
  const baseEvent = {
    title: "Night Market Live",
    startsAt: "2026-12-01T20:00:00.000Z",
    venue: "Vicar Street",
    city: "Dublin",
  };

  it("rejects a dangerous event artwork URL", () => {
    for (const url of DANGEROUS) {
      expect(
        EventDraftInput.safeParse({ ...baseEvent, artworkUrl: url }).success,
        `artworkUrl ${url}`,
      ).toBe(false);
    }
    expect(
      EventDraftInput.safeParse({ ...baseEvent, artworkUrl: "https://example.com/a.png" }).success,
    ).toBe(true);
  });

  it("rejects a dangerous seller website or image", () => {
    for (const url of DANGEROUS) {
      expect(SellerProfilePatch.safeParse({ websiteUrl: url }).success, `website ${url}`).toBe(
        false,
      );
      expect(SellerProfilePatch.safeParse({ imageUrl: url }).success, `image ${url}`).toBe(false);
    }
  });

  it("rejects a dangerous social link", () => {
    for (const url of DANGEROUS) {
      expect(SocialLink.safeParse({ label: "Site", url }).success, `link ${url}`).toBe(false);
      expect(
        SellerProfilePatch.safeParse({ socialLinks: [{ label: "Site", url }] }).success,
        `patch link ${url}`,
      ).toBe(false);
    }
  });
});

describe("safeExternalUrl", () => {
  it("returns safe URLs unchanged", () => {
    for (const url of SAFE) {
      expect(safeExternalUrl(url)).toBe(url);
    }
  });

  it("returns null for a dangerous or unusable value", () => {
    for (const url of [...DANGEROUS, "example.com", "", "   ", null, undefined]) {
      expect(safeExternalUrl(url), `${url} must not be rendered`).toBeNull();
    }
  });

  it("is the render-time defence for rows written before the rule existed", () => {
    // A stored value never passes straight into an href.
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
  });
});
