/**
 * Stand-in for missing artwork: a soft gradient with the name's first letter.
 *
 * The colour comes from the name, so the same event or seller always gets the same one and a
 * grid of cards without artwork doesn't read as a row of identical grey boxes. Decorative only:
 * the name is always printed next to it.
 */

/** First letter worth showing: a leading tag such as "[DEMO]" is skipped. */
export function placeholderInitial(name: string): string {
  const withoutTags = name.replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim();
  const letter = (withoutTags || name.trim()).match(/[\p{L}\p{N}]/u)?.[0];
  return letter ? letter.toUpperCase() : "?";
}

/** A stable hue (0–359) for a name. */
export function placeholderHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

export function ArtworkPlaceholder({ name, className = "" }: { name: string; className?: string }) {
  const hue = placeholderHue(name);
  return (
    <div
      aria-hidden="true"
      className={`grid size-full place-items-center text-5xl font-bold text-white/85 ${className}`}
      style={{
        backgroundImage: `radial-gradient(120% 120% at 0% 0%, hsl(${hue} 70% 38%) 0%, transparent 60%), linear-gradient(135deg, hsl(${(hue + 40) % 360} 55% 22%), hsl(${(hue + 300) % 360} 60% 14%))`,
      }}
    >
      {placeholderInitial(name)}
    </div>
  );
}
