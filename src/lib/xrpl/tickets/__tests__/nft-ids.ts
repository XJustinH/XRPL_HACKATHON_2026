import { decodeAccountID } from "xrpl";

/**
 * Test helper: a real-format NFTokenID for `issuer` with the given taxon and sequence,
 * with the taxon scrambled exactly as the ledger does (so `parseNFTokenID` recovers it).
 * Flags 0x0008 (transferable), no transfer fee.
 */
export function nftokenIdFor(issuer: string, taxon: number, sequence = 7): string {
  const account = Buffer.from(decodeAccountID(issuer)).toString("hex");
  const mask = Number((BigInt(384160001) * BigInt(sequence) + BigInt(2459)) % BigInt(4294967296));
  const scrambled = ((taxon ^ mask) >>> 0).toString(16).padStart(8, "0");
  return `00080000${account}${scrambled}${sequence.toString(16).padStart(8, "0")}`.toUpperCase();
}
