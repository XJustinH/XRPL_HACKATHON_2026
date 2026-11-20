// @vitest-environment node
import { describe, expect, it } from "vitest";

import { escapeXml, renderTicketSvg } from "../image";

const base = {
  eventTitle: "The Testnet Tones: Live at The Ledger Rooms",
  tierName: "General Admission",
  serial: 3,
  startsAt: new Date("2027-03-12T20:00:00.000Z"),
  venue: "The Ledger Rooms",
  city: "Dublin",
  networkLabel: "XRPL Testnet",
};

describe("renderTicketSvg", () => {
  it("renders the event, tier, serial, date and place", () => {
    const svg = renderTicketSvg(base);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("General Admission");
    expect(svg).toContain("#3");
    expect(svg).toContain("12 Mar 2027 · 20:00 UTC");
    expect(svg).toContain("The Ledger Rooms, Dublin");
    expect(svg).toContain("XRPL Testnet · NFT ticket");
  });

  it("escapes event text so it cannot inject markup or scripts", () => {
    const svg = renderTicketSvg({
      ...base,
      eventTitle: `<script>alert("x")</script> & 'friends'`,
      venue: "<b>",
    });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  it("loads nothing external", () => {
    expect(renderTicketSvg(base)).not.toMatch(/href=|url\(http|<image|<foreignObject/);
  });

  it("keeps very long titles to three lines", () => {
    const svg = renderTicketSvg({ ...base, eventTitle: "word ".repeat(60) });
    expect(svg.match(/<tspan/g)).toHaveLength(3);
  });
});

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  });
});
