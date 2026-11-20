import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearConnectedWallet, resetConnectedWalletCache, saveConnectedWallet } from "@/features/wallet/wallet-store";
import { CheckInCodePanel } from "./checkin-code-panel";

vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,QR" } }));

const TICKET = "11111111-1111-4111-8111-111111111111";
const CHALLENGE = "22222222-2222-4222-8222-222222222222";
const SIGN_IN = "33333333-3333-4333-8333-333333333333";
const WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: string, message = "msg") => json(status, { error: { code, message }, requestId: "r" });

const issued = {
  data: {
    challengeId: CHALLENGE,
    eventId: "e",
    ticketId: TICKET,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    qrPayload: "xtc1.code",
    messageToSign: "m",
  },
};
const signRequest = (status: string, networkMatches: boolean | null = null) => ({
  id: SIGN_IN,
  kind: "SIGN_IN",
  status,
  signUrl: `https://xumm.app/sign/${SIGN_IN}`,
  qrPngUrl: `https://xumm.app/sign/${SIGN_IN}_q.png`,
  expiresAt: null,
  account: status === "SIGNED" ? WALLET : null,
  walletNetwork: null,
  networkMatches,
});
const approval = { data: { signRequest: signRequest("PENDING"), proof: `${SIGN_IN}.tag` } };

/** Routes requests by URL so the test reads like the real sequence. */
function respond(statusSequence: Response[], { issue = json(201, issued), prove = json(200, { data: { status: "PROVEN" } }) } = {}) {
  const polls = [...statusSequence];
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/checkin/challenges") return issue;
    if (url.endsWith("/sign-request")) return json(201, approval);
    if (url.endsWith("/prove")) return prove;
    if (url.startsWith("/api/wallet/sign-requests/")) return polls.shift() ?? json(200, { data: signRequest("PENDING") });
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  saveConnectedWallet({ address: WALLET, network: "TESTNET", connectedAt: new Date().toISOString() });
});
afterEach(() => {
  clearConnectedWallet();
  resetConnectedWalletCache();
  vi.unstubAllGlobals();
});

describe("CheckInCodePanel", () => {
  it("asks to connect a wallet first", () => {
    clearConnectedWallet();
    render(<CheckInCodePanel ticketId={TICKET} />);
    expect(screen.getByRole("link", { name: "Connect wallet" })).toHaveAttribute("href", "/connect");
  });

  it("issues a code, waits for Xaman approval, proves it, then shows the gate QR", async () => {
    const user = userEvent.setup();
    respond([json(200, { data: signRequest("OPENED") }), json(200, { data: signRequest("SIGNED", true) })]);
    render(<CheckInCodePanel ticketId={TICKET} pollIntervalMs={1} />);

    await user.click(screen.getByRole("button", { name: "Show check-in code" }));
    expect(await screen.findByAltText("Check-in QR code")).toHaveAttribute("src", "data:image/png;base64,QR");
    expect(screen.getByText(/Expires in 4:5\d|Expires in 5:00/)).toBeInTheDocument();

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ ticketId: TICKET, walletAddress: WALLET });
    expect(urls).toContain(`/api/checkin/challenges/${CHALLENGE}/sign-request`);
    const proveCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith("/prove"))!;
    expect(JSON.parse(proveCall[1].body)).toEqual({ proof: `${SIGN_IN}.tag` });
  });

  it("shows the Xaman approval step and no gate code while approval is pending", async () => {
    const user = userEvent.setup();
    respond([]); // every poll answers PENDING
    render(<CheckInCodePanel ticketId={TICKET} pollIntervalMs={5} />);
    await user.click(screen.getByRole("button", { name: "Show check-in code" }));
    expect(await screen.findByRole("link", { name: "Open in Xaman" })).toHaveAttribute("href", approval.data.signRequest.signUrl);
    expect(screen.getByText("Waiting for approval…")).toBeInTheDocument();
    expect(screen.queryByAltText("Check-in QR code")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Show check-in code" })).toBeInTheDocument();
  });

  it("does not show a code when the wallet declines", async () => {
    const user = userEvent.setup();
    respond([json(200, { data: signRequest("REJECTED") })]);
    render(<CheckInCodePanel ticketId={TICKET} pollIntervalMs={1} />);
    await user.click(screen.getByRole("button", { name: "Show check-in code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined the request in Xaman.");
    expect(screen.queryByAltText("Check-in QR code")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).endsWith("/prove"))).toBe(false);
  });

  it("refuses a signature from the wrong network", async () => {
    const user = userEvent.setup();
    respond([json(200, { data: signRequest("SIGNED", false) })]);
    render(<CheckInCodePanel ticketId={TICKET} pollIntervalMs={1} />);
    await user.click(screen.getByRole("button", { name: "Show check-in code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Switch Xaman to XRPL Testnet");
  });

  it("explains when the connected wallet doesn't hold the ticket", async () => {
    const user = userEvent.setup();
    respond([], { issue: fail(403, "WRONG_OWNER", "Your linked wallet does not currently hold this ticket.") });
    render(<CheckInCodePanel ticketId={TICKET} />);
    await user.click(screen.getByRole("button", { name: "Show check-in code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This wallet doesn't hold the ticket");
  });

  it("shows a failed proof instead of a code", async () => {
    const user = userEvent.setup();
    respond([json(200, { data: signRequest("SIGNED", true) })], { prove: fail(401, "INVALID_PROOF") });
    render(<CheckInCodePanel ticketId={TICKET} pollIntervalMs={1} />);
    await user.click(screen.getByRole("button", { name: "Show check-in code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wallet approval failed");
    expect(screen.queryByAltText("Check-in QR code")).not.toBeInTheDocument();
  });
});
