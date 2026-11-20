import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventMints, MintMappingReport, MintTicketView, TransactionRequest } from "@/contracts/xrpl";

import { MintTicketsPanel } from "./mint-tickets-panel";

const EVENT = "3b241101-e2bb-4255-8caf-4136c566a962";
const TIER = "9c8e3a43-6c1f-4d2b-8f0e-2b6f8d8f6c11";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NFT = "00080000A1B2C3D4E5F60718293A4B5C6D7E8F9012345678ABCDEF0100000007";
const TX = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";

/** Deterministic UUIDs: ticket n and request n. */
const ticketId = (n: number) => `6f1d3c2e-8a4b-4c5d-9e6f-${String(n).padStart(12, "0")}`;
const requestId = (n: number) => `515b9d76-f7cc-4f3b-979e-${String(n).padStart(12, "0")}`;

function ticket(serial: number, extra: Partial<MintTicketView> = {}): MintTicketView {
  return {
    id: ticketId(serial),
    eventId: EVENT,
    tierId: TIER,
    serial,
    nftokenId: null,
    issuerAddress: ISSUER,
    metadataUri: `http://localhost:3000/api/tickets/${ticketId(serial)}/metadata`,
    mintStatus: "PENDING",
    mintTxHash: null,
    mintedAt: null,
    primarySoldAt: null,
    cachedOwnership: { ownerAddress: null, syncStatus: "UNSYNCED", syncedAt: null, ledgerIndex: null },
    nftExplorerUrl: null,
    mintTxExplorerUrl: null,
    primaryOffer: null,
    ...extra,
  };
}

const minted = (serial: number) =>
  ticket(serial, {
    mintStatus: "MINTED",
    nftokenId: NFT,
    mintTxHash: TX,
    mintedAt: "2026-11-20T19:00:00.000Z",
    nftExplorerUrl: `https://testnet.xrpl.org/nft/${NFT}`,
    mintTxExplorerUrl: `https://testnet.xrpl.org/transactions/${TX}`,
  });

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

function txRequest(n: number, status: TransactionRequest["status"]): TransactionRequest {
  return {
    id: requestId(n),
    purpose: "MINT_TICKET",
    reference: ticketId(n),
    status,
    transactionType: "NFTokenMint",
    account: ISSUER,
    instruction: `Mint ticket #${n}`,
    signUrl: `https://xumm.app/sign/${requestId(n)}`,
    qrPngUrl: `https://xumm.app/sign/${requestId(n)}_q.png`,
    expiresAt: null,
    txHash: status === "CONFIRMED" ? TX : null,
    engineResult: status === "CONFIRMED" ? "tesSUCCESS" : null,
    ledgerIndex: null,
    explorerUrl: status === "CONFIRMED" ? `https://testnet.xrpl.org/transactions/${TX}` : null,
    failureReason: null,
  };
}

function report(extra: Partial<MintMappingReport> = {}): MintMappingReport {
  return {
    eventId: EVENT,
    issuers: [ISSUER],
    mintsFound: 1,
    recorded: [],
    verified: 1,
    issues: [],
    complete: true,
    checkedAt: "2026-11-20T21:00:00.000Z",
    ...extra,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : data), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Fake API. Each mint POST reserves ticket n and returns request n (both 1-based); the status
 * of request n is `status[n]` (CONFIRMED unless a test sets it). `listings` are returned by
 * successive GETs of the event's mints (the last repeats).
 */
function mockApi({
  listings,
  mint,
  status = {},
  reconcile = () => json(report()),
}: {
  listings: EventMints[];
  mint?: (n: number) => Response;
  status?: Record<number, TransactionRequest["status"]>;
  reconcile?: () => Response;
}) {
  const lists = [...listings];
  let posts = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `/api/events/${EVENT}/mints/reconcile` && method === "POST") return reconcile();
    if (url === `/api/events/${EVENT}/mints` && method === "POST") {
      posts += 1;
      if (mint) return mint(posts);
      return json(
        { ticket: ticket(posts), request: txRequest(posts, "PENDING"), metadataPublic: false },
        201,
      );
    }
    if (url === `/api/events/${EVENT}/mints`) return json(lists.length > 1 ? lists.shift() : lists[0]);
    const listing = /^\/api\/tickets\/(.+)\/primary-offers$/.exec(url);
    if (listing && method === "POST") {
      posts += 1;
      const n = 100 + posts; // listing requests are numbered from 101
      const offer = {
        id: ticketId(n),
        ticketId: listing[1],
        state: "PENDING_SIGNATURE",
        amountDrops: "2500000",
      };
      return json({ offer, request: { ...txRequest(n, "PENDING"), purpose: "CREATE_PRIMARY_OFFER" } }, 201);
    }
    const polled = /^\/api\/wallet\/transaction-requests\/.+-(\d{12})$/.exec(url);
    if (polled) {
      const n = Number(polled[1]);
      return json(txRequest(n, status[n] ?? "CONFIRMED"));
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const mintPosts = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === `/api/events/${EVENT}/mints` && init?.method === "POST",
  );
const idempotencyKeys = (fetchMock: ReturnType<typeof mockApi>) =>
  mintPosts(fetchMock).map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));

describe("MintTicketsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints the next ticket with the proven wallet and shows it once validated", async () => {
    const fetchMock = mockApi({
      listings: [eventMints([]), eventMints([ticket(1)]), eventMints([minted(1)], 1)],
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} pollIntervalMs={5} />);

    expect(await screen.findByText("2.5 XRP · Minted 0 of 50")).toBeVisible();
    expect(screen.getByText(ISSUER)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Mint next ticket" }));

    expect(await screen.findByText(/not on a public address/)).toBeVisible();
    expect(await screen.findByText("Minted 1 ticket of General Admission on XRPL Testnet.")).toBeVisible();

    const tickets = await screen.findByRole("list", { name: "General Admission: minted tickets" });
    expect(within(tickets).getByRole("link", { name: /NFT/ })).toHaveAttribute(
      "href",
      `https://testnet.xrpl.org/nft/${NFT}`,
    );
    expect(screen.getByText("2.5 XRP · Minted 1 of 50")).toBeVisible();

    const [, init] = mintPosts(fetchMock)[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ tierId: TIER });
    expect(idempotencyKeys(fetchMock)).toEqual([expect.stringMatching(/^[0-9a-f]{32}-0$/)]);
  });

  it("mints a tier's remaining quantity one approval at a time, with progress (XRPL-025)", async () => {
    const fetchMock = mockApi({ listings: [eventMints([], 0, 3)] });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} pollIntervalMs={5} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint all 3 remaining" }));

    const progress = await screen.findByRole("region", { name: "Minting progress" });
    expect(
      await within(progress).findByText("Minted 3 tickets of General Admission on XRPL Testnet."),
    ).toBeVisible();
    expect(within(progress).getByText("3 of 3 minted")).toBeVisible();

    // One request per ticket, all under one run key: retrying step n replays it instead of duplicating.
    const keys = idempotencyKeys(fetchMock);
    expect(keys).toHaveLength(3);
    const run = keys[0]!.slice(0, 32);
    expect(keys).toEqual([`${run}-0`, `${run}-1`, `${run}-2`]);
  });

  it("stops the run at the first ticket that is not confirmed", async () => {
    const fetchMock = mockApi({ listings: [eventMints([], 0, 3)], status: { 2: "REJECTED" } });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} pollIntervalMs={5} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint all 3 remaining" }));

    expect(
      await screen.findByText("You declined the last ticket in Xaman, so minting stopped."),
    ).toBeVisible();
    expect(screen.getByText("1 of 3 minted")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 30)); // a few more poll intervals
    expect(mintPosts(fetchMock)).toHaveLength(2);
  });

  it("can stop after the ticket being approved", async () => {
    const status: Record<number, TransactionRequest["status"]> = { 1: "PENDING" };
    const fetchMock = mockApi({ listings: [eventMints([], 0, 3)], status });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} pollIntervalMs={5} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint all 3 remaining" }));

    await userEvent.click(await screen.findByRole("button", { name: "Stop after this ticket" }));
    expect(screen.getByRole("button", { name: "Stopping after this ticket" })).toBeDisabled();
    status[1] = "CONFIRMED";

    expect(await screen.findByText("Stopped after 1 of 3, as asked.")).toBeVisible();
    expect(mintPosts(fetchMock)).toHaveLength(1);
  });

  it("retries a step with the same Idempotency-Key when no response arrived", async () => {
    const fetchMock = mockApi({
      listings: [eventMints([], 0, 2)],
      mint: (n) => {
        if (n === 1) throw new TypeError("Failed to fetch");
        return json({ ticket: ticket(1), request: txRequest(1, "PENDING"), metadataPublic: true }, 201);
      },
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} pollIntervalMs={5} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint next ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Minted 1 ticket of General Admission on XRPL Testnet.")).toBeVisible();
    const keys = idempotencyKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("shows the server's reason when a mint cannot start", async () => {
    mockApi({
      listings: [eventMints([])],
      mint: () =>
        json(
          { error: { code: "NOT_EVENT_OWNER", message: "Only this event's organiser can do this." } },
          403,
        ),
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mint next ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only this event's organiser can do this.");
  });

  it("shows minted, pending and failed tickets separately", async () => {
    mockApi({
      listings: [
        eventMints(
          [minted(1), ticket(2), ticket(3, { mintStatus: "SUBMITTED" }), ticket(4, { mintStatus: "FAILED" })],
          1,
          10,
        ),
      ],
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);

    expect(await screen.findByText("1 minted · 2 pending · 1 failed")).toBeVisible();
    const mintedList = screen.getByRole("list", { name: "General Admission: minted tickets" });
    expect(within(mintedList).getByText("#1")).toBeVisible();
    const pendingList = screen.getByRole("list", { name: "General Admission: pending tickets" });
    expect(within(pendingList).getAllByRole("listitem")).toHaveLength(2);
    const failedList = screen.getByRole("list", { name: "General Admission: failed tickets" });
    expect(within(failedList).getByText("#4")).toBeVisible();
    // Failed tickets get reused, so they still count as left to mint: 10 - 1 minted - 2 pending.
    expect(screen.getByRole("button", { name: "Mint all 7 remaining" })).toBeEnabled();
  });

  it("asks for a proven wallet before minting", async () => {
    mockApi({ listings: [eventMints([])] });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={null} />);

    expect(await screen.findByRole("link", { name: "Connect wallet" })).toHaveAttribute("href", "/connect");
    expect(await screen.findByRole("button", { name: "Mint next ticket" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mint all 50 remaining" })).toBeDisabled();
  });

  it("does not offer more tickets than the tier holds", async () => {
    mockApi({ listings: [eventMints([minted(1)], 1, 1)] });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);
    expect(await screen.findByRole("button", { name: "All tickets minted" })).toBeDisabled();
  });

  it("waits for pending mints instead of reserving past the supply", async () => {
    mockApi({ listings: [eventMints([minted(1), ticket(2)], 1, 2)] });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);
    expect(await screen.findByRole("button", { name: "Waiting on pending mints" })).toBeDisabled();
  });

  it("explains when the event has no tiers yet", async () => {
    mockApi({ listings: [{ eventId: EVENT, title: "Testnet Tones Live", tiers: [] }] });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);
    expect(await screen.findByText("This event has no ticket tiers yet.")).toBeVisible();
  });

  it("reloads the tiers when the page's tiers change", async () => {
    const fetchMock = mockApi({ listings: [eventMints([]), eventMints([], 0, 80)] });
    const { rerender } = render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} tiersVersion="a" />);
    await screen.findByText("2.5 XRP · Minted 0 of 50");
    rerender(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} tiersVersion="b" />);
    expect(await screen.findByText("2.5 XRP · Minted 0 of 80")).toBeVisible();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === `/api/events/${EVENT}/mints`),
      ).toHaveLength(2),
    );
  });

  it("lists minted tickets for sale at the tier price, one approval at a time (XRPL-029)", async () => {
    const fetchMock = mockApi({ listings: [eventMints([minted(1), minted(2)], 2, 2)] });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} pollIntervalMs={5} />);
    await userEvent.click(await screen.findByRole("button", { name: "List 2 for sale at 2.5 XRP" }));

    const progress = await screen.findByRole("region", { name: "Listing progress" });
    expect(
      await within(progress).findByText("Listed 2 tickets of General Admission for sale at 2.5 XRP."),
    ).toBeVisible();
    expect(within(progress).getByText("2 of 2 listed")).toBeVisible();

    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => /primary-offers$/.test(String(url)) && init?.method === "POST",
    );
    expect(posts.map(([url]) => String(url))).toEqual([
      `/api/tickets/${ticketId(1)}/primary-offers`,
      `/api/tickets/${ticketId(2)}/primary-offers`,
    ]);
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{}, {}]); // the price is the tier's
    const keys = posts.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(keys).toEqual([`${keys[0]!.slice(0, 32)}-0`, `${keys[0]!.slice(0, 32)}-1`]);
  });

  it("shows each minted ticket's sale status and only offers unlisted tickets", async () => {
    const offer = (n: number, state: "ACTIVE" | "PENDING_SIGNATURE" | "FAILED") => ({
      id: ticketId(200 + n),
      state,
      amountDrops: "2500000",
      offerIndex: null,
    });
    mockApi({
      listings: [
        eventMints(
          [
            { ...minted(1), primaryOffer: offer(1, "ACTIVE") },
            { ...minted(2), primaryOffer: offer(2, "PENDING_SIGNATURE") },
            { ...minted(3), primarySoldAt: "2026-11-20T20:00:00.000Z" },
            { ...minted(4), primaryOffer: offer(4, "FAILED") },
            minted(5),
          ],
          5,
          5,
        ),
      ],
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);

    const list = await screen.findByRole("list", { name: "General Admission: minted tickets" });
    expect(within(list).getByText("For sale · 2.5 XRP")).toBeVisible();
    expect(within(list).getByText("Listing: awaiting approval")).toBeVisible();
    expect(within(list).getByText("Sold")).toBeVisible();
    expect(within(list).getByText("Not for sale")).toBeVisible(); // its listing failed
    expect(screen.getByText("1 for sale · 1 sold")).toBeVisible();
    // Only #4 (failed listing) and #5 (never listed) can be listed now.
    expect(screen.getByRole("button", { name: "List 2 for sale at 2.5 XRP" })).toBeEnabled();
  });

  it("checks the event against the ledger and reloads after recording a missed mint", async () => {
    const fetchMock = mockApi({
      listings: [eventMints([ticket(1)]), eventMints([minted(1)], 1)],
      reconcile: () => json(report({ recorded: [ticketId(1)] })),
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check against the ledger" }));

    expect(
      await screen.findByText("1 minted ticket matches the XRP Ledger. Recorded 1 mint found on the ledger."),
    ).toBeVisible();
    expect(await screen.findByText("2.5 XRP · Minted 1 of 50")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/events/${EVENT}/mints/reconcile`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists problems the ledger check found", async () => {
    mockApi({
      listings: [eventMints([minted(1)], 1)],
      reconcile: () =>
        json(
          report({
            verified: 0,
            complete: false,
            issues: [
              {
                problem: "MINT_TX_MISMATCH",
                ticketId: ticketId(1),
                serial: 1,
                nftokenId: NFT,
                txHash: TX,
                detail: "Transaction shows a different NFT",
              },
            ],
          }),
        ),
    });
    render(<MintTicketsPanel eventId={EVENT} issuerAddress={ISSUER} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check against the ledger" }));

    expect(await screen.findByText("1 problem found. Nothing was changed for it.")).toBeVisible();
    expect(screen.getByText("#1: Transaction shows a different NFT")).toBeVisible();
    expect(screen.getByText(/only its most recent transactions were read/)).toBeVisible();
  });
});
