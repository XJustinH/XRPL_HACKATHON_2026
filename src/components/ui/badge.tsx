const toneClasses = {
  neutral: "bg-surface text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  positive: "bg-positive-soft text-positive border-transparent",
  caution: "bg-caution-soft text-caution border-transparent",
  critical: "bg-critical-soft text-critical border-transparent",
} as const;

export type BadgeTone = keyof typeof toneClasses;

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}
