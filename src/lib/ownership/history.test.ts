import { describe, expect, it } from "vitest";
import { buildTicketHistory, type RecordedTransfer } from "./history";

const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BUYER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const OTHER = "rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const tx = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

const mint = { issuerAddress: ISSUER, txHash: tx(1), ledgerIndex: 100, at: new Date("2026-11-21T10:00:00Z") };
const sale = (over: Partial<RecordedTransfer> = {}): RecordedTransfer => ({
  kind: "PRIMARY",
  fromAddress: ISSUER,
  toAddress: BUYER,
  amountDrops: "25000000",
  txHash: tx(2),
  ledgerIndex: 200,
  at: new Date("2026-11-21T11:00:00Z"),
  listedLedgerIndex: 150,
  ...over,
});
const txUrl = (hash: string) => `https://explorer/transactions/${hash}`;
const summary = (entries: ReturnType<typeof buildTicketHistory>) =>
  entries.map((e) => `${e.kind}:${e.source}:${e.fromAddress ?? "-"}>${e.toAddress ?? "-"}@${e.ledgerIndex ?? "?"}`);

describe("buildTicketHistory", () => {
  it("is all platform steps when every move went through the app", () => {
    const entries = buildTicketHistory({
      mint,
      transfers: [
        sale(),
        sale({ kind: "GIFT", fromAddress: BUYER, toAddress: FRIEND, amountDrops: "0", txHash: tx(3), ledgerIndex: 300 }),
      ],
      current: { status: "VERIFIED", ownerAddress: FRIEND, ledgerIndex: 400 },
      txUrl,
    });
    expect(summary(entries)).toEqual([
      `MINT:PLATFORM:->${ISSUER}@100`,
      `PRIMARY_SALE:PLATFORM:${ISSUER}>${BUYER}@200`,
      `GIFT:PLATFORM:${BUYER}>${FRIEND}@300`,
    ]);
    expect(entries[1]).toMatchObject({
      amountDrops: "25000000",
      explorerTxUrl: `https://explorer/transactions/${tx(2)}`,
      at: "2026-11-21T11:00:00.000Z",
    });
    expect(entries[2]?.amountDrops).toBe("0");
  });

  it("marks a move outside the app after the last recorded step", () => {
    const entries = buildTicketHistory({
      mint,
      transfers: [sale()],
      current: { status: "VERIFIED", ownerAddress: OTHER, ledgerIndex: 400 },
      txUrl,
    });
    expect(summary(entries).at(-1)).toBe(`OUTSIDE_APP:EXTERNAL:${BUYER}>${OTHER}@400`);
    expect(entries.at(-1)).toMatchObject({ txHash: null, explorerTxUrl: null, amountDrops: null, at: null });
  });

  it("marks a gap between recorded steps, seen when the next listing was validated", () => {
    const entries = buildTicketHistory({
      mint,
      transfers: [
        sale(),
        sale({ kind: "RESALE", fromAddress: OTHER, toAddress: FRIEND, txHash: tx(3), ledgerIndex: 500, listedLedgerIndex: 450 }),
      ],
      current: { status: "VERIFIED", ownerAddress: FRIEND, ledgerIndex: 600 },
      txUrl,
    });
    expect(summary(entries)).toEqual([
      `MINT:PLATFORM:->${ISSUER}@100`,
      `PRIMARY_SALE:PLATFORM:${ISSUER}>${BUYER}@200`,
      `OUTSIDE_APP:EXTERNAL:${BUYER}>${OTHER}@450`,
      `RESALE:PLATFORM:${OTHER}>${FRIEND}@500`,
    ]);
  });

  it("also marks the seller moving an unsold ticket away before listing it", () => {
    const entries = buildTicketHistory({
      mint,
      transfers: [sale({ fromAddress: OTHER })],
      current: { status: "VERIFIED", ownerAddress: BUYER, ledgerIndex: 300 },
      txUrl,
    });
    expect(summary(entries)[1]).toBe(`OUTSIDE_APP:EXTERNAL:${ISSUER}>${OTHER}@150`);
  });

  it("shows a brokered sale's broker, then the buyer as reached outside the app", () => {
    const BROKER = FRIEND;
    const entries = buildTicketHistory({
      mint,
      transfers: [sale({ toAddress: BROKER })],
      current: { status: "VERIFIED", ownerAddress: BUYER, ledgerIndex: 300 },
      txUrl,
    });
    expect(summary(entries).slice(1)).toEqual([
      `PRIMARY_SALE:PLATFORM:${ISSUER}>${BROKER}@200`,
      `OUTSIDE_APP:EXTERNAL:${BROKER}>${BUYER}@300`,
    ]);
  });

  it("ends at the last recorded step when the holder couldn't be verified", () => {
    for (const current of [null, { status: "PENDING" as const, ownerAddress: null, ledgerIndex: null }]) {
      expect(summary(buildTicketHistory({ mint, transfers: [sale()], current, txUrl }))).toHaveLength(2);
    }
  });

  it("notes an NFT destroyed outside the app", () => {
    const entries = buildTicketHistory({
      mint,
      transfers: [sale()],
      current: { status: "BURNED", ownerAddress: null, ledgerIndex: 900 },
      txUrl,
    });
    expect(summary(entries).at(-1)).toBe(`BURNED:EXTERNAL:${BUYER}>-@900`);
  });

  it("is empty for a ticket that was never minted", () => {
    expect(buildTicketHistory({ mint: null, transfers: [], current: null, txUrl })).toEqual([]);
  });
});
