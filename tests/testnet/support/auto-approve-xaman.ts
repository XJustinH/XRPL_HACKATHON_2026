import { createPrivateKey, randomUUID } from "node:crypto";
import { makeSignInBlob, type TestKey } from "@/lib/auth/testing/signin-blob";
import type { XrplConfig } from "@/lib/xrpl";
import {
  XamanClient,
  type CreatePayloadInput,
  type XamanCreatedPayload,
  type XamanPayloadResult,
} from "@/lib/xrpl/wallet/xaman";
import type { TestnetConnection, TestWallet } from "./testnet";

/**
 * Stands in for the Xaman app on a person's phone in the live lifecycle suite (XRPL-050).
 *
 * In the app, every request goes to Xaman, where the wallet's owner approves it. This double approves
 * automatically with throwaway Testnet wallets instead, and answers `getPayload` in Xaman's format:
 *  - **Transactions:** it signs exactly the transaction the server built, adding only Fee, Sequence and
 *    LastLedgerSequence as Xaman does, and submits it.
 *  - **Sign-ins** (wallet-control proof): the request names no account, because a person picks one in
 *    Xaman, so the test chooses with `signInAs(wallet)`. The double returns a sign-in signed by that
 *    wallet's own key, with the memo naming the request, like Xaman's. Nothing is submitted.
 * Everything else is the app's real code: building requests, checking signatures, following
 * transactions to a validated ledger, and recording the results.
 */
export class AutoApproveXaman extends XamanClient {
  /** Every transaction a person would have been asked to approve, in order. */
  readonly approved: { uuid: string; txjson: Record<string, unknown>; hash: string }[] = [];
  /** Every sign-in a person would have approved, in order. */
  readonly signIns: { uuid: string; account: string }[] = [];
  private readonly results = new Map<string, XamanPayloadResult>();
  private readonly walletsByAddress: Map<string, TestWallet>;
  private signInWallet: TestWallet | null = null;

  constructor(
    private readonly connection: TestnetConnection,
    private readonly network: XrplConfig["network"],
    wallets: readonly TestWallet[],
  ) {
    // Placeholder credentials: this double never calls the Xaman API.
    super({ apiKey: "test-double", apiSecret: "test-double" });
    this.walletsByAddress = new Map(wallets.map((wallet) => [wallet.classicAddress, wallet]));
  }

  /** The wallet that approves the next sign-in requests, as a person would pick an account in Xaman. */
  signInAs(wallet: TestWallet): void {
    this.signInWallet = wallet;
  }

  override async createPayload(input: CreatePayloadInput): Promise<XamanCreatedPayload> {
    const uuid = randomUUID();
    if (input.txjson.TransactionType === "SignIn") {
      this.approveSignIn(uuid, input);
    } else {
      await this.approveTransaction(uuid, input);
    }
    return {
      uuid,
      next: { always: `https://xaman.app/sign/${uuid}` },
      refs: { qr_png: `https://xaman.app/sign/${uuid}_q.png`, websocket_status: "" },
      pushed: false,
    };
  }

  override async getPayload(uuid: string): Promise<XamanPayloadResult> {
    const result = this.results.get(uuid);
    if (!result) throw new Error(`Unknown test request ${uuid}`);
    return result;
  }

  override async cancelPayload(): Promise<{ cancelled: boolean; reason: string }> {
    // Requests are approved as soon as they are created, so there is never anything left to cancel.
    return { cancelled: false, reason: "ALREADY_RESOLVED" };
  }

  private async approveTransaction(uuid: string, input: CreatePayloadInput): Promise<void> {
    const account = input.txjson.Account;
    const wallet = typeof account === "string" ? this.walletsByAddress.get(account) : undefined;
    if (!wallet) throw new Error(`No test wallet can sign for Account ${String(account)}`);

    const { txBlob, hash, engineResult } = await this.connection.withClient(async ({ client }) => {
      const prepared = await client.autofill(input.txjson as Parameters<typeof client.autofill>[0]);
      const signed = wallet.sign(prepared);
      const submitted = await client.submit(signed.tx_blob);
      return { txBlob: signed.tx_blob, hash: signed.hash, engineResult: submitted.result.engine_result };
    }, "test wallet approval");

    this.approved.push({ uuid, txjson: input.txjson, hash });
    this.record(uuid, input, { account: wallet.classicAddress, hex: txBlob, txid: hash, dispatched_result: engineResult });
  }

  private approveSignIn(uuid: string, input: CreatePayloadInput): void {
    const wallet = this.signInWallet;
    if (!wallet) throw new Error("Call signInAs(wallet) before a sign-in request");
    const hex = makeSignInBlob({ signRequestId: uuid, key: signingKeyOf(wallet) });
    this.signIns.push({ uuid, account: wallet.classicAddress });
    this.record(uuid, input, { account: wallet.classicAddress, hex, txid: null, dispatched_result: null });
  }

  private record(
    uuid: string,
    input: CreatePayloadInput,
    response: { account: string; hex: string; txid: string | null; dispatched_result: string | null },
  ): void {
    const forceNetwork = input.options?.force_network;
    this.results.set(uuid, {
      meta: {
        exists: true,
        uuid,
        resolved: true,
        signed: true,
        cancelled: false,
        expired: false,
        app_opened: true,
        force_network: typeof forceNetwork === "string" ? forceNetwork : null,
      },
      payload: {
        tx_type: String(input.txjson.TransactionType),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        request_json: input.txjson,
      },
      response: { ...response, environment_nodetype: this.network, resolved_at: new Date().toISOString() },
      custom_meta: (input.custom_meta ?? null) as XamanPayloadResult["custom_meta"],
    });
  }
}

/** PKCS#8 DER header for a raw 32-byte Ed25519 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The wallet's own Ed25519 master key, in the form the sign-in blob helper signs with. */
function signingKeyOf(wallet: TestWallet): TestKey {
  if (!/^ED[0-9A-F]{64}$/i.test(wallet.privateKey)) {
    throw new Error("Sign-ins need an Ed25519 test wallet (the faucet's default)");
  }
  const raw = Buffer.from(wallet.privateKey.slice(2), "hex");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
  return { publicKeyHex: wallet.publicKey, address: wallet.classicAddress, privateKey };
}
