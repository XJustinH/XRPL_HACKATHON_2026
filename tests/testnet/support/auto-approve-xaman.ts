import { randomUUID } from "node:crypto";
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
 */
export class AutoApproveXaman extends XamanClient {
  /** Every transaction a person would have been asked to approve, in order. */
  readonly approved: { uuid: string; txjson: Record<string, unknown>; hash: string }[] = [];
  private readonly results = new Map<string, XamanPayloadResult>();
  private readonly walletsByAddress: Map<string, TestWallet>;

  constructor(
    private readonly connection: TestnetConnection,
    private readonly network: XrplConfig["network"],
    wallets: readonly TestWallet[],
  ) {
    // Placeholder credentials: this double never calls the Xaman API.
    super({ apiKey: "test-double", apiSecret: "test-double" });
    this.walletsByAddress = new Map(wallets.map((wallet) => [wallet.classicAddress, wallet]));
  }

  override async createPayload(input: CreatePayloadInput): Promise<XamanCreatedPayload> {
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
