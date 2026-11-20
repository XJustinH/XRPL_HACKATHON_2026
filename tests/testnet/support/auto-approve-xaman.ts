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
 * In the app, every transaction goes to Xaman, where its owner approves it and Xaman submits it. This
 * double approves automatically with a throwaway Testnet wallet instead. It signs exactly the
 * transaction the server built, adding only Fee, Sequence and LastLedgerSequence as Xaman does, submits
 * it, and answers `getPayload` in Xaman's format. Everything else is the app's real code: building the
 * transaction, following it to a validated ledger, and recording the result.
 *
 * It also answers Xaman **SignIn** requests (wallet-control proofs, e.g. check-in, XRPL-045). A SignIn
 * has no Account: in Xaman the person picks which account approves, so the test says so with
 * `signInWith(wallet)`. The double returns a blob in Xaman's SignIn format (Agent A's `makeSignInBlob`),
 * signed with that wallet's own Testnet key. A SignIn is never submitted to the ledger.
 */
export class AutoApproveXaman extends XamanClient {
  /** Every transaction a person would have been asked to approve, in order. */
  readonly approved: { uuid: string; txjson: Record<string, unknown>; hash: string }[] = [];
  /** Every sign-in (wallet-control proof) a person approved, in order. Kept apart from `approved`. */
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

  /** The wallet that approves the next SignIn request, as a person would pick their account in Xaman. */
  signInWith(wallet: TestWallet): void {
    this.signInWallet = wallet;
  }

  override async createPayload(input: CreatePayloadInput): Promise<XamanCreatedPayload> {
    if (input.txjson.TransactionType === "SignIn") return this.approveSignIn(input);
    const account = input.txjson.Account;
    const wallet = typeof account === "string" ? this.walletsByAddress.get(account) : undefined;
    if (!wallet) throw new Error(`No test wallet can sign for Account ${String(account)}`);

    const { txBlob, hash, engineResult } = await this.connection.withClient(async ({ client }) => {
      const prepared = await client.autofill(input.txjson as Parameters<typeof client.autofill>[0]);
      const signed = wallet.sign(prepared);
      const submitted = await client.submit(signed.tx_blob);
      return { txBlob: signed.tx_blob, hash: signed.hash, engineResult: submitted.result.engine_result };
    }, "test wallet approval");

    const uuid = randomUUID();
    const forceNetwork = input.options?.force_network;
    this.approved.push({ uuid, txjson: input.txjson, hash });
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
      response: {
        account: wallet.classicAddress,
        hex: txBlob,
        txid: hash,
        environment_nodetype: this.network,
        dispatched_result: engineResult,
        resolved_at: new Date().toISOString(),
      },
      custom_meta: (input.custom_meta ?? null) as XamanPayloadResult["custom_meta"],
    });
    return {
      uuid,
      next: { always: `https://xaman.app/sign/${uuid}` },
      refs: { qr_png: `https://xaman.app/sign/${uuid}_q.png`, websocket_status: "" },
      pushed: false,
    };
  }

  private approveSignIn(input: CreatePayloadInput): XamanCreatedPayload {
    const wallet = this.signInWallet;
    if (!wallet) throw new Error("Call signInWith(wallet) before requesting a sign-in");

    const uuid = randomUUID();
    const forceNetwork = input.options?.force_network;
    this.signIns.push({ uuid, account: wallet.classicAddress });
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
        tx_type: "SignIn",
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        request_json: input.txjson,
      },
      response: {
        account: wallet.classicAddress,
        hex: makeSignInBlob({ signRequestId: uuid, key: testKeyFromWallet(wallet) }),
        txid: null,
        environment_nodetype: this.network,
        dispatched_result: null,
        resolved_at: new Date().toISOString(),
      },
      custom_meta: (input.custom_meta ?? null) as XamanPayloadResult["custom_meta"],
    });
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
}

/** PKCS#8 header for a raw 32-byte Ed25519 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * The wallet's own key in the form `makeSignInBlob` signs with. Faucet wallets are Ed25519 (xrpl's
 * default), whose private key is "ED" followed by the raw 32-byte key.
 */
function testKeyFromWallet(wallet: TestWallet): TestKey {
  if (!wallet.privateKey.startsWith("ED") || !wallet.publicKey.startsWith("ED")) {
    throw new Error("Only Ed25519 test wallets can approve a sign-in in this double");
  }
  const raw = Buffer.from(wallet.privateKey.slice(2), "hex");
  return {
    publicKeyHex: wallet.publicKey,
    address: wallet.classicAddress,
    privateKey: createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" }),
  };
}
