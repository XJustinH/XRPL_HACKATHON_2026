// @vitest-environment node
import { convertHexToString, NFTokenMintFlags } from "xrpl";
import { describe, expect, it } from "vitest";

import { TicketNftMetadata } from "@/contracts/xrpl";

import {
  buildTicketMetadata,
  encodeNftUri,
  MAX_NFT_URI_BYTES,
  ticketTaxon,
  TICKET_NFT_FLAGS,
} from "../metadata";

const EVENT_ID = "5eed0000-0000-4000-8000-000000000101";
const TIER_ID = "5eed0000-0000-4000-8000-000000000201";
const TICKET_ID = "7a1c3b9e-2f4d-4c6a-9b8e-1d2f3a4b5c6d";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

const input = {
  ticket: { id: TICKET_ID, serial: 2 },
  event: {
    id: EVENT_ID,
    title: "The Testnet Tones: Live",
    description: "An evening of original songs.",
    startsAt: new Date("2027-03-12T20:00:00.000Z"),
    endsAt: new Date("2027-03-12T23:00:00.000Z"),
    venue: "The Ledger Rooms",
    city: "Dublin",
  },
  tier: { id: TIER_ID, name: "General Admission", priceDrops: "2500000" },
  issuerAddress: ISSUER,
  network: "TESTNET" as const,
  imageUrl: `https://tickets.example/api/tickets/${TICKET_ID}/image`,
};

function allKeys(value: unknown, keys: string[] = []): string[] {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      allKeys(child, keys);
    }
  }
  return keys;
}

describe("buildTicketMetadata", () => {
  it("ties the NFT to exactly one ticket, event and tier, and names its issuer", () => {
    const metadata = TicketNftMetadata.parse(buildTicketMetadata(input));
    expect(metadata.ticket).toEqual({
      ticketId: TICKET_ID,
      eventId: EVENT_ID,
      tierId: TIER_ID,
      serial: 2,
      issuer: ISSUER,
      network: "TESTNET",
    });
    expect(metadata.name).toBe("The Testnet Tones: Live — General Admission #2");
    expect(metadata.image).toBe(input.imageUrl);
    expect(metadata.event).toEqual({
      title: "The Testnet Tones: Live",
      startsAt: "2027-03-12T20:00:00.000Z",
      endsAt: "2027-03-12T23:00:00.000Z",
      venue: "The Ledger Rooms",
      city: "Dublin",
    });
    expect(metadata.tier).toEqual({ name: "General Admission", priceDrops: "2500000" });
    expect(metadata.attributes).toContainEqual({ trait_type: "Serial", value: 2 });
  });

  it("contains no attendee information", () => {
    const keys = allKeys(buildTicketMetadata(input)).map((key) => key.toLowerCase());
    for (const forbidden of ["owner", "holder", "buyer", "customer", "attendee", "email", "user"]) {
      expect(keys.some((key) => key.includes(forbidden))).toBe(false);
    }
  });

  it("keeps long event descriptions to a sensible size", () => {
    const long = buildTicketMetadata({ ...input, event: { ...input.event, description: "x".repeat(5000) } });
    expect(long.description.length).toBeLessThanOrEqual(1000);
  });
});

describe("ticket identity on the ledger", () => {
  it("mints transferable tickets that the issuer cannot burn", () => {
    expect(TICKET_NFT_FLAGS).toBe(NFTokenMintFlags.tfTransferable);
    expect(TICKET_NFT_FLAGS & NFTokenMintFlags.tfBurnable).toBe(0);
  });

  it("derives a stable 32-bit taxon per event", () => {
    const taxon = ticketTaxon(EVENT_ID);
    expect(taxon).toBe(ticketTaxon(EVENT_ID));
    expect(taxon).toBe(0x5eed0000);
    expect(Number.isInteger(taxon) && taxon >= 0 && taxon <= 0xffffffff).toBe(true);
    expect(ticketTaxon(TICKET_ID)).not.toBe(taxon);
    expect(() => ticketTaxon("not-a-uuid")).toThrow(/UUID/);
  });

  it("hex-encodes the metadata URI within the ledger's 256-byte limit", () => {
    const uri = `https://tickets.example/api/tickets/${TICKET_ID}/metadata`;
    expect(convertHexToString(encodeNftUri(uri))).toBe(uri);
    expect(() => encodeNftUri("")).toThrow(/1-256 bytes/);
    expect(() => encodeNftUri(`https://x.example/${"a".repeat(MAX_NFT_URI_BYTES)}`)).toThrow(/256 bytes/);
  });
});
