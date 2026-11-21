import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtworkPlaceholder, placeholderHue, placeholderInitial } from "./artwork-placeholder";

describe("placeholderInitial", () => {
  it("skips a leading tag, so a demo event doesn't show a bracket", () => {
    expect(placeholderInitial("[DEMO] The Testnet Tones")).toBe("T");
    expect(placeholderInitial("[DEMO] [NEW] open mic")).toBe("O");
  });

  it("uses the first letter or digit, and falls back when there is none", () => {
    expect(placeholderInitial("  élan live")).toBe("É");
    expect(placeholderInitial("2 Many DJs")).toBe("2");
    expect(placeholderInitial("[DEMO]")).toBe("D");
    expect(placeholderInitial("   ")).toBe("?");
  });
});

describe("ArtworkPlaceholder", () => {
  it("gives the same name the same colour, and is hidden from assistive technology", () => {
    expect(placeholderHue("Summer Fest")).toBe(placeholderHue("Summer Fest"));
    expect(placeholderHue("Summer Fest")).not.toBe(placeholderHue("Winter Fest"));
    const { container } = render(<ArtworkPlaceholder name="Summer Fest" />);
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveAttribute("aria-hidden", "true");
    expect(box).toHaveTextContent("S");
  });
});
