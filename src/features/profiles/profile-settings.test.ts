import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE_SETTINGS,
  mergeProfileSettings,
  readProfileSettings,
} from "./profile-settings";

describe("readProfileSettings", () => {
  it("returns defaults for an absent or non-object column", () => {
    for (const input of [null, undefined, "", 7, "a string"]) {
      expect(readProfileSettings(input)).toEqual(EMPTY_PROFILE_SETTINGS);
    }
  });

  it("returns defaults for an empty object", () => {
    expect(readProfileSettings({})).toEqual(EMPTY_PROFILE_SETTINGS);
  });

  it("reads stored values", () => {
    const settings = readProfileSettings({
      bio: "We put on shows.",
      city: "Dublin",
      websiteUrl: "https://example.com",
      imageUrl: "https://example.com/a.png",
      socialLinks: [{ label: "Instagram", url: "https://instagram.com/x" }],
      interests: ["techno", "jazz"],
      visibility: "PRIVATE",
    });
    expect(settings.bio).toBe("We put on shows.");
    expect(settings.city).toBe("Dublin");
    expect(settings.interests).toEqual(["techno", "jazz"]);
    expect(settings.visibility).toBe("PRIVATE");
  });

  it("salvages the valid fields when one is corrupt", () => {
    // A profile written by hand or an older version must not break the page.
    const settings = readProfileSettings({
      bio: "Kept",
      city: 12345,
      socialLinks: "not-an-array",
      visibility: "SOMETHING_ELSE",
    });
    expect(settings.bio).toBe("Kept");
    expect(settings.city).toBeNull();
    expect(settings.socialLinks).toEqual([]);
    expect(settings.visibility).toBe("PUBLIC");
  });

  it("defaults visibility to public rather than leaving it undefined", () => {
    expect(readProfileSettings({ bio: "x" }).visibility).toBe("PUBLIC");
  });
});

describe("mergeProfileSettings", () => {
  it("preserves keys owned by other features", () => {
    // The column is shared, so an unrelated preference must survive a save.
    const merged = mergeProfileSettings(
      { theme: "dark", notifications: { email: false }, bio: "Old" },
      { bio: "New" },
    );
    expect(merged.theme).toBe("dark");
    expect(merged.notifications).toEqual({ email: false });
    expect(merged.bio).toBe("New");
  });

  it("leaves fields absent from the patch untouched", () => {
    const merged = mergeProfileSettings({ bio: "Keep me", city: "Cork" }, { city: "Dublin" });
    expect(merged.bio).toBe("Keep me");
    expect(merged.city).toBe("Dublin");
  });

  it("treats an empty string as clearing a URL or city", () => {
    const merged = mergeProfileSettings(
      { websiteUrl: "https://example.com", imageUrl: "https://example.com/a.png", city: "Cork" },
      { websiteUrl: "", imageUrl: "", city: "" },
    );
    expect(merged.websiteUrl).toBeNull();
    expect(merged.imageUrl).toBeNull();
    expect(merged.city).toBeNull();
  });

  it("trims a city rather than storing padding", () => {
    expect(mergeProfileSettings({}, { city: "  Dublin  " }).city).toBe("Dublin");
    expect(mergeProfileSettings({}, { city: "   " }).city).toBeNull();
  });

  it("rejects a social link that is not a valid URL", () => {
    expect(() =>
      mergeProfileSettings({}, { socialLinks: [{ label: "Site", url: "example.com" }] }),
    ).toThrow();
  });

  it("rejects more social links than allowed", () => {
    const link = { label: "Site", url: "https://example.com" };
    expect(() => mergeProfileSettings({}, { socialLinks: Array(7).fill(link) })).toThrow();
    expect(() =>
      mergeProfileSettings({}, { socialLinks: Array(6).fill(link) }),
    ).not.toThrow();
  });

  it("rejects an unknown visibility value", () => {
    expect(() => mergeProfileSettings({}, { visibility: "SEMI_PUBLIC" })).toThrow();
  });

  it("drops blank interests and trims the rest", () => {
    expect(mergeProfileSettings({}, { interests: [" techno ", "jazz"] }).interests).toEqual([
      "techno",
      "jazz",
    ]);
    expect(() => mergeProfileSettings({}, { interests: ["  "] })).toThrow();
  });

  it("starts from defaults when there is nothing stored", () => {
    const merged = mergeProfileSettings(null, { bio: "First save" });
    expect(merged.bio).toBe("First save");
    expect(merged.visibility).toBe("PUBLIC");
    expect(merged.socialLinks).toEqual([]);
  });
});
