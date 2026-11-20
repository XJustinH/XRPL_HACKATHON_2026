import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfferStatus, PrimaryOfferListing, TransactionRequest } from "@/contracts/xrpl";

import { BuyTicket } from "./buy-ticket";

const OFFER_ID = "7be7283c-71b8-47bf-89f0-a0d8183492da";
const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const BUYER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const NFT = "00080000A1B2C3D4E5F60718293A4B5C6D7E8F9012345678ABCDEF0100000007";
const TX = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";

const OFFER: PrimaryOfferListing = {
  offerId: OFFER_ID,
  offerIndex: "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF",
  nftokenId: NFT,
  sellerAddress: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  amountDrops: "2500000",
  tierId: "9c8e3a43-6c1f-4d2b-8f0e-2b6f8d8f6c11",
  tierName: "General Admission",
  ticketId: TICKET,
  serial: 3,
  expiresAt: null,
};

const requestId = (n: number) => `515b9d76-f7cc-4f3b-979e-${String(n).padStart(12, "0")}`;

function txRequest(n: number, status: TransactionRequest["status"], extra: Partial<TransactionRequest> = {}) {
  return {
    id: requestId(n),
    purpose: "ACCEPT_PRIMARY_OFFER",
    reference: OFFER_ID,
    status,
    transactionType: "NFTokenAcceptOffer",
    account: BUYER,
    instruction: "Buy ticket",
    signUrl: `https://xumm.app/sign/${requestId(n)}`,
    qrPngUrl: `https://xumm.app/sign/${requestId(n)}_q.png`,
    expiresAt: null,
    txHash: status === "CONFIRMED" ? TX : null,
    engineResult: status === "CONFIRMED" ? "tesSUCCESS" : null,
    ledgerIndex: null,
    explorerUrl: status === "CONFIRMED" ? `https://testnet.xrpl.org/transactions/${TX}` : null,
    failureReason: null,
    ...extra,
  } satisfies TransactionRequest;
}

function offerStatus(state: OfferStatus["offer"]["state"], soldAt: string | null): OfferStatus {
  return {
    offer: {
      id: OFFER_ID,
      ticketId: TICKET,
      nftokenId: NFT,
      offerIndex: OFFER.offerIndex,
      kind: "PRIMARY",
      state,
      ownerAddress: OFFER.sellerAddress,
      destinationAddress: null,
      amountDrops: "2500000",
      expiresAt: null,
      createTxHash: null,
      acceptTxHash: state === "ACCEPTED" ? TX : null,
      cancelTxHash: null,
    },
    ticketId: TICKET,
    serial: 3,
    soldAt,
    purchasePending: false,
    acceptTxExplorerUrl: state === "ACCEPTED" ? `https://testnet.xrpl.org/transactions/${TX}` : null,
    nftExplorerUrl: `https://testnet.xrpl.org/nft/${NFT}`,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : data), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Fake API: purchase n gets request n; `outcome` is what each request ends as; `after` is the offer then. */
function mockApi({
  outcome,
  after,
  accept,
}: {
  outcome: TransactionRequest["status"] | ((n: number) => TransactionRequest);
  after: () => OfferStatus;
  accept?: (n: number) => Response;
}) {
  let posts = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `/api/offers/${OFFER_ID}/accept-intent` && method === "POST") {
      posts += 1;
      if (accept) return accept(posts);
      return json(
        {
          offerId: OFFER_ID,
          ticketId: TICKET,
          serial: 3,
          tierName: "General Admission",
          eventTitle: "Gig",
          amountDrops: "2500000",
          request: txRequest(posts, "PENDING"),
        },
        201,
      );
    }
    if (url === `/api/offers/${OFFER_ID}`) return json(after());
    const polled = /^\/api\/wallet\/transaction-requests\/.+-(\d{12})$/.exec(url);
    if (polled) {
      const n = Number(polled[1]);
      return json(typeof outcome === "function" ? outcome(n) : txRequest(n, outcome));
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const purchasePosts = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith("/accept-intent") && init?.method === "POST",
  );

describe("BuyTicket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks a buyer without a proven wallet to connect, instead of failing a sale", () => {
    render(<BuyTicket offer={OFFER} buyerAddress={null} />);
    expect(screen.getByRole("link", { name: "Connect wallet" })).toHaveAttribute("href", "/connect");
    expect(screen.queryByRole("button", { name: /Buy/ })).not.toBeInTheDocument();
  });

  it("buys the ticket: approval in Xaman, then the validated sale", async () => {
    const fetchMock = mockApi({
      outcome: "CONFIRMED",
      after: () => offerStatus("ACCEPTED", "2026-11-20T22:00:00.000Z"),
    });
    render(<BuyTicket offer={OFFER} buyerAddress={BUYER} pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy for 2.5 XRP" }));

    expect(
      await screen.findByRole("region", { name: "Approve the purchase: General Admission #3 for 2.5 XRP" }),
    ).toBeVisible();
    expect(await screen.findByText("You own ticket #3. It's in your wallet as an NFT.")).toBeVisible();
    expect(screen.getByRole("link", { name: "View the ticket NFT" })).toHaveAttribute(
      "href",
      `https://testnet.xrpl.org/nft/${NFT}`,
    );
    expect(screen.getByRole("link", { name: "Purchase transaction" })).toHaveAttribute(
      "href",
      `https://testnet.xrpl.org/transactions/${TX}`,
    );

    const [, init] = purchasePosts(fetchMock)[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({}); // the server uses the session's proven wallet
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("says the ticket is still available after a declined purchase, and can try again", async () => {
    const fetchMock = mockApi({ outcome: "REJECTED", after: () => offerStatus("ACTIVE", null) });
    render(<BuyTicket offer={OFFER} buyerAddress={BUYER} pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy for 2.5 XRP" }));

    expect(await screen.findByText("This ticket is still available.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Approve the purchase: General Admission #3 for 2.5 XRP" });
    const keys = purchasePosts(fetchMock).map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key"),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]); // a new attempt, not a replay
  });

  it("says when someone else bought it first", async () => {
    mockApi({
      outcome: (n) =>
        txRequest(n, "FAILED", { failureReason: "LEDGER_REJECTED", engineResult: "tecOBJECT_NOT_FOUND" }),
      after: () => offerStatus("STALE", null),
    });
    render(<BuyTicket offer={OFFER} buyerAddress={BUYER} pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy for 2.5 XRP" }));

    expect(await screen.findByText("This ticket was sold to someone else. Pick another one.")).toBeVisible();
  });

  it("shows the server's reason when the purchase can't start", async () => {
    mockApi({
      outcome: "PENDING",
      after: () => offerStatus("STALE", null),
      accept: () =>
        json(
          {
            error: {
              code: "CONFLICT",
              message: "This ticket was just sold or taken off sale. Pick another one.",
            },
          },
          409,
        ),
    });
    render(<BuyTicket offer={OFFER} buyerAddress={BUYER} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy for 2.5 XRP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This ticket was just sold or taken off sale.",
    );
  });

  it("retries with the same Idempotency-Key when no response arrived", async () => {
    const fetchMock = mockApi({
      outcome: "CONFIRMED",
      after: () => offerStatus("ACCEPTED", "2026-11-20T22:00:00.000Z"),
      accept: (n) => {
        if (n === 1) throw new TypeError("Failed to fetch");
        return json(
          {
            offerId: OFFER_ID,
            ticketId: TICKET,
            serial: 3,
            tierName: "General Admission",
            eventTitle: "Gig",
            amountDrops: "2500000",
            request: txRequest(n, "PENDING"),
          },
          201,
        );
      },
    });
    render(<BuyTicket offer={OFFER} buyerAddress={BUYER} pollIntervalMs={5} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy for 2.5 XRP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You own ticket #3. It's in your wallet as an NFT.")).toBeVisible();
    const keys = purchasePosts(fetchMock).map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key"),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
