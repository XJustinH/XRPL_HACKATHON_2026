import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventMints, MintTicketView, TransactionRequest } from "@/contracts/xrpl";

import { MintTicketsPanel } from "./mint-tickets-panel";

const EVENT = "3b241101-e2bb-4255-8caf-4136c566a962";
const TIER = "9c8e3a43-6c1f-4d2b-8f0e-2b6f8d8f6c11";
const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const REQUEST = "515b9d76-f7cc-4f3b-979e-a82500340424";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NFT = "00080000A1B2C3D4E5F60718293A4B5C6D7E8F9012345678ABCDEF0100000007";
const TX = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const EVENTS = [
  { id: EVENT, title: "Testnet Tones Live", status: "PUBLISHED", startsAt: "2027-03-12T20:00:00.000Z" },
];

function ticket(extra: Partial<MintTicketView> = {}): MintTicketView {
  return {
    id: TICKET,
    eventId: EVENT,
    tierId: TIER,
    serial: 1,
    nftokenId: null,
    issuerAddress: ISSUER,
    metadataUri: `http://localhost:3000/api/tickets/${TICKET}/metadata`,
    mintStatus: "PENDING",
    mintTxHash: null,
    mintedAt: null,
    primarySoldAt: null,
    cachedOwnership: { ownerAddress: null, syncStatus: "UNSYNCED", syncedAt: null, ledgerIndex: null },
    nftExplorerUrl: null,
    mintTxExplorerUrl: null,
    ...extra,
  };
}

function eventMints(tickets: MintTicketView[], mintedQuantity = 0, totalSupply = 50): EventMints {
  return {
    eventId: EVENT,
    title: "Testnet Tones Live",
    tiers: [
      {
        id: TIER,
        eventId: EVENT,
        name: "General Admission",
        description: "",
        priceDrops: "2500000",
        totalSupply,
        mintedQuantity,
        sortOrder: 0,
        tickets,
      },
    ],
  };
}

function txRequest(
  status: TransactionRequest["status"],
  extra: Partial<TransactionRequest> = {},
): TransactionRequest {
  return {
    id: REQUEST,
    purpose: "MINT_TICKET",
    reference: TICKET,
    status,
    transactionType: "NFTokenMint",
    account: ISSUER,
    instruction: "Mint ticket #1",
    signUrl: `https://xumm.app/sign/${REQUEST}`,
    qrPngUrl: `https://xumm.app/sign/${REQUEST}_q.png`,
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...extra,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : data), {
    status,
    headers: { "content-type": "application/json" },
  });

const MINTED = ticket({
  mintStatus: "MINTED",
  nftokenId: NFT,
  mintTxHash: TX,
  mintedAt: "2026-11-20T19:00:00.000Z",
  nftExplorerUrl: `https://testnet.xrpl.org/nft/${NFT}`,
  mintTxExplorerUrl: `https://testnet.xrpl.org/transactions/${TX}`,
});

/** Fake API. `listings` are returned by successive GETs (the last repeats). */
function mockApi({
  listings,
  mint = () => json({ ticket: ticket(), request: txRequest("PENDING"), metadataPublic: false }, 201),
  statuses = [
    txRequest("CONFIRMED", { txHash: TX, explorerUrl: `https://testnet.xrpl.org/transactions/${TX}` }),
  ],
}: {
  listings: EventMints[];
  mint?: () => Response | Promise<Response>;
  statuses?: TransactionRequest[];
}) {
  const lists = [...listings];
  const polls = [...statuses];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `/api/events/${EVENT}/mints` && method === "POST") return mint();
    if (url === `/api/events/${EVENT}/mints`) return json(lists.length > 1 ? lists.shift() : lists[0]);
    if (url.startsWith("/api/wallet/transaction-requests/"))
      return json(polls.length > 1 ? polls.shift() : polls[0]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("MintTicketsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints the next ticket with the proven wallet and shows it once validated", async () => {
    const fetchMock = mockApi({
      listings: [eventMints([]), eventMints([ticket()]), eventMints([MINTED], 1)],
    });
    render(<MintTicketsPanel events={EVENTS} issuerAddress={ISSUER} pollIntervalMs={5} />);

    expect(await screen.findByText("2.5 XRP · Minted 0 of 50")).toBeVisible();
    expect(screen.getByText(ISSUER)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Mint next ticket" }));

    expect(
      await screen.findByRole("region", { name: "Approve the mint: General Admission #1" }),
    ).toBeVisible();
    expect(screen.getByText(/not on a public address/)).toBeVisible();
    expect(await screen.findByText("Confirmed on XRPL Testnet.")).toBeVisible();

    const tickets = await screen.findByRole("list", { name: "General Admission tickets" });
    expect(await within(tickets).findByText("Minted")).toBeVisible();
    expect(within(tickets).getByRole("link", { name: /NFT/ })).toHaveAttribute(
      "href",
      `https://testnet.xrpl.org/nft/${NFT}`,
    );
    expect(screen.getByText("2.5 XRP · Minted 1 of 50")).toBeVisible();

    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).toEqual({ tierId: TIER });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("asks for a proven wallet before minting", async () => {
    mockApi({ listings: [eventMints([])] });
    render(<MintTicketsPanel events={EVENTS} issuerAddress={null} />);

    expect(await screen.findByRole("link", { name: "Connect wallet" })).toHaveAttribute("href", "/connect");
    expect(await screen.findByRole("button", { name: "Mint next ticket" })).toBeDisabled();
  });

  it("does not offer more tickets than the tier holds", async () => {
    mockApi({ listings: [eventMints([MINTED], 1, 1)] });
    render(<MintTicketsPanel events={EVENTS} issuerAddress={ISSUER} />);
    expect(await screen.findByRole("button", { name: "All tickets minted" })).toBeDisabled();
  });

  it("shows the server's reason when a mint cannot start", async () => {
    mockApi({
      listings: [eventMints([])],
      mint: () => json({ error: { code: "FORBIDDEN", message: "Only the event's seller can mint" } }, 403),
    });
    render(<MintTicketsPanel events={EVENTS} issuerAddress={ISSUER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint next ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the event's seller can mint");
  });

  it("retries with the same Idempotency-Key when no response arrived", async () => {
    let attempts = 0;
    const fetchMock = mockApi({
      listings: [eventMints([])],
      mint: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return json({ ticket: ticket(), request: txRequest("PENDING"), metadataPublic: true }, 201);
      },
    });
    render(<MintTicketsPanel events={EVENTS} issuerAddress={ISSUER} pollIntervalMs={5} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint next ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    await userEvent.click(screen.getByRole("button", { name: "Mint next ticket" }));
    await screen.findByRole("region", { name: "Approve the mint: General Admission #1" });

    const keys = fetchMock.mock.calls
      .filter(([, i]) => i?.method === "POST")
      .map(([, i]) => new Headers(i?.headers).get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("explains when there is nothing to mint for", () => {
    render(<MintTicketsPanel events={[]} issuerAddress={ISSUER} />);
    expect(screen.getByText(/You have no events yet/)).toBeVisible();
  });
});
