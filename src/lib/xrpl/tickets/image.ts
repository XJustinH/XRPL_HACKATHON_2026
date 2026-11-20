/**
 * Generated ticket artwork (XRPL-023): a self-contained SVG, so every ticket NFT has an
 * image even when the event has no artwork. All text is XML-escaped, and the SVG loads
 * nothing external.
 */

export interface TicketImageInput {
  eventTitle: string;
  tierName: string;
  serial: number;
  startsAt: Date;
  venue: string;
  city: string;
  networkLabel: string;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** Greedy word wrap into at most `maxLines` lines of about `maxChars` characters. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && text.length > lines.join(" ").length) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines;
}

function formatStart(date: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `${day} · ${time} UTC`;
}

export function renderTicketSvg(input: TicketImageInput): string {
  const titleLines = wrap(input.eventTitle, 22, 3);
  const title = titleLines
    .map((line, index) => `<tspan x="48" dy="${index === 0 ? 0 : 56}">${escapeXml(line)}</tspan>`)
    .join("");
  const place = escapeXml(`${input.venue}, ${input.city}`);
  const label = escapeXml(`Ticket: ${input.eventTitle}, ${input.tierName} #${input.serial}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840" role="img" aria-label="${label}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#0c0e13"/></linearGradient></defs>
<rect width="600" height="840" rx="36" fill="url(#bg)"/>
<g font-family="Helvetica, Arial, sans-serif" fill="#ffffff">
<text x="48" y="96" font-size="22" letter-spacing="4" opacity="0.8">ADMISSION TICKET</text>
<text x="48" y="190" font-size="46" font-weight="700">${title}</text>
<text x="48" y="420" font-size="30" font-weight="600">${escapeXml(input.tierName)}</text>
<text x="48" y="470" font-size="26" opacity="0.85">${escapeXml(formatStart(input.startsAt))}</text>
<text x="48" y="510" font-size="26" opacity="0.85">${place}</text>
<line x1="36" y1="600" x2="564" y2="600" stroke="#ffffff" stroke-width="3" stroke-dasharray="14 12" opacity="0.5"/>
<text x="48" y="700" font-size="96" font-weight="700">#${input.serial}</text>
<text x="48" y="780" font-size="22" letter-spacing="2" opacity="0.8">${escapeXml(`${input.networkLabel} · NFT ticket`)}</text>
</g>
</svg>`;
}
