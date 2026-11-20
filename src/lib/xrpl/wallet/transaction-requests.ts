import { decode, isValidClassicAddress } from "xrpl";
import { z } from "zod";

import {
  TransactionPurpose,
  type TransactionFailureReason,
  type TransactionRequest,
  type TransactionRequestStatus,
} from "@/contracts/xrpl";

import { loadXrplConfig, type XrplConfig } from "../config";
import { XrplServiceError } from "../errors";
import { createXrplQueryService, type XrplQueryService } from "../query";
import { signRequestStatus } from "./sign-requests";
import { loadXamanCredentials, XamanClient, type XamanPayloadResult } from "./xaman";

/** How long a transaction request stays open in Xaman. */
export const TRANSACTION_REQUEST_EXPIRY_MINUTES = 10;
const SIGN_URL_BASE = "https://xumm.app/sign";
const MAX_INSTRUCTION_LENGTH = 280;
const MAX_REFERENCE_LENGTH = 100;
const RequestId = z.uuid();
const TxHashHex = /^[0-9A-Fa-f]{64}$/;

/** The one transaction type each purpose may request. Extended by XRPL-024/029/031/036/040-042. */
const PURPOSE_TRANSACTION_TYPES: Record<TransactionPurpose, string> = {
  TEST: "AccountSet",
  MINT_TICKET: "NFTokenMint",
  CREATE_PRIMARY_OFFER: "NFTokenCreateOffer",
  ACCEPT_PRIMARY_OFFER: "NFTokenAcceptOffer",
};

const RequestMeta = z.object({
  purpose: TransactionPurpose,
  reference: z.string().nullable().optional(),
});

export interface CreateTransactionRequestInput {
  purpose: TransactionPurpose;
  /**
   * The unsigned transaction, built on the server by the purpose's own code. It must name
   * the signing `Account`; Xaman fills in Fee, Sequence and LastLedgerSequence.
   */
  txjson: { TransactionType: string; Account: string } & Record<string, unknown>;
  /** Shown to the user in Xaman, e.g. "Mint ticket #12 for Summer Fest". */
  instruction: string;
  /** App record the request is for (e.g. a ticket ID). */
  reference?: string | null;
}

type LedgerReader = Pick<XrplQueryService, "getTransaction" | "getNetworkStatus">;

function parseRequestId(id: string): string {
  const parsed = RequestId.safeParse(id);
  if (!parsed.success) throw new XrplServiceError("INVALID_INPUT", "Transaction request ID must be a UUID");
  return parsed.data;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** LastLedgerSequence from a signed blob, or null if it cannot be read. */
function lastLedgerSequenceOf(signedHex: string | null | undefined): number | null {
  if (!signedHex) return null;
  try {
    const value = decode(signedHex).LastLedgerSequence;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/** tem* and tef* results mean the transaction never reached a ledger and never will. */
function isNeverApplied(result: string | null | undefined): boolean {
  return typeof result === "string" && /^(tem|tef)/.test(result);
}

/**
 * Transaction approvals through Xaman (XRPL-014). The user signs in their own wallet
 * and Xaman submits; the app then follows the transaction to a validated ledger.
 * A request only counts as CONFIRMED once the ledger validated it with tesSUCCESS.
 */
export class WalletTransactionRequests {
  constructor(
    private readonly config: XrplConfig,
    private readonly xaman: XamanClient,
    private readonly ledger: LedgerReader,
  ) {}

  async create(input: CreateTransactionRequestInput): Promise<TransactionRequest> {
    const purpose = TransactionPurpose.parse(input.purpose);
    const expectedType = PURPOSE_TRANSACTION_TYPES[purpose];
    if (input.txjson.TransactionType !== expectedType) {
      throw new XrplServiceError(
        "INVALID_INPUT",
        `A ${purpose} request must be a ${expectedType} transaction`,
      );
    }
    if (!isValidClassicAddress(input.txjson.Account)) {
      throw new XrplServiceError("INVALID_INPUT", "The signing Account must be a valid XRPL classic address");
    }
    const instruction = input.instruction.trim();
    if (!instruction || instruction.length > MAX_INSTRUCTION_LENGTH) {
      throw new XrplServiceError(
        "INVALID_INPUT",
        `Instruction must be 1-${MAX_INSTRUCTION_LENGTH} characters`,
      );
    }
    const reference = input.reference ?? null;
    if (reference !== null && reference.length > MAX_REFERENCE_LENGTH) {
      throw new XrplServiceError(
        "INVALID_INPUT",
        `Reference must be at most ${MAX_REFERENCE_LENGTH} characters`,
      );
    }

    const created = await this.xaman.createPayload({
      txjson: input.txjson,
      options: {
        submit: true,
        expire: TRANSACTION_REQUEST_EXPIRY_MINUTES,
        force_network: this.config.network,
      },
      custom_meta: { instruction, blob: { purpose, reference } },
    });
    return this.get(created.uuid);
  }

  async get(id: string): Promise<TransactionRequest> {
    const uuid = parseRequestId(id);
    const result = await this.xaman.getPayload(uuid);
    const meta = RequestMeta.safeParse(result.custom_meta?.blob);
    const account = result.payload.request_json?.Account;
    if (result.payload.tx_type === "SignIn" || !meta.success || typeof account !== "string") {
      throw new XrplServiceError("NOT_FOUND", "Transaction request not found");
    }

    const base: TransactionRequest = {
      id: uuid,
      purpose: meta.data.purpose,
      reference: meta.data.reference ?? null,
      status: "PENDING",
      transactionType: result.payload.tx_type,
      account,
      instruction: result.custom_meta?.instruction ?? "",
      signUrl: `${SIGN_URL_BASE}/${uuid}`,
      qrPngUrl: `${SIGN_URL_BASE}/${uuid}_q.png`,
      expiresAt: isoOrNull(result.payload.expires_at),
      txHash: null,
      engineResult: null,
      ledgerIndex: null,
      explorerUrl: null,
      failureReason: null,
    };

    const walletStatus = signRequestStatus(result.meta);
    if (walletStatus !== "SIGNED") return { ...base, status: walletStatus };
    return this.followOnLedger(base, result);
  }

  /** Withdraws a request that has not been signed yet, then returns its current state. */
  async cancel(id: string): Promise<TransactionRequest> {
    const current = await this.get(id);
    if (current.status === "PENDING" || current.status === "OPENED") {
      await this.xaman.cancelPayload(current.id);
      return this.get(current.id);
    }
    return current;
  }

  private async followOnLedger(
    base: TransactionRequest,
    result: XamanPayloadResult,
  ): Promise<TransactionRequest> {
    const txid = result.response.txid;
    const txHash = txid && TxHashHex.test(txid) ? txid.toUpperCase() : null;
    const signed = { ...base, txHash };
    const fail = (failureReason: TransactionFailureReason, extra: Partial<TransactionRequest> = {}) => ({
      ...signed,
      status: "FAILED" as TransactionRequestStatus,
      failureReason,
      ...extra,
    });

    const walletNetwork = result.response.environment_nodetype ?? result.meta.force_network ?? null;
    if (walletNetwork !== this.config.network) return fail("WRONG_NETWORK");
    if (!txHash) return { ...signed, status: "SUBMITTED" };

    let lookup: Awaited<ReturnType<LedgerReader["getTransaction"]>>;
    try {
      lookup = await this.ledger.getTransaction(txHash);
    } catch {
      // The ledger is briefly unreachable: the transaction may still validate, so keep waiting.
      return { ...signed, status: "SUBMITTED" };
    }

    if (lookup.status === "VALIDATED") {
      const onLedger = {
        engineResult: lookup.engineResult,
        ledgerIndex: lookup.ledgerIndex,
        explorerUrl: lookup.explorerUrl,
      };
      return lookup.succeeded
        ? { ...signed, ...onLedger, status: "CONFIRMED" }
        : fail("LEDGER_REJECTED", onLedger);
    }

    const dispatched = result.response.dispatched_result ?? null;
    if (isNeverApplied(dispatched)) return fail("NETWORK_REJECTED", { engineResult: dispatched });

    const lastLedger = lastLedgerSequenceOf(result.response.hex);
    if (lastLedger !== null) {
      try {
        const validatedIndex = (await this.ledger.getNetworkStatus()).validatedLedger?.index;
        if (validatedIndex !== undefined && validatedIndex > lastLedger) return fail("NOT_VALIDATED_IN_TIME");
      } catch {
        // Unknown ledger height: keep waiting.
      }
    }
    return { ...signed, status: "SUBMITTED" };
  }
}

export function createWalletTransactionRequests(
  config: XrplConfig = loadXrplConfig(),
  client: XamanClient = new XamanClient(loadXamanCredentials()),
  ledger: LedgerReader = createXrplQueryService(config),
): WalletTransactionRequests {
  return new WalletTransactionRequests(config, client, ledger);
}

const SHARED_KEY = Symbol.for("xrpl-ticketing.walletTransactionRequests");

/** Process-wide shared instance for route handlers. Throws CONFIG_ERROR if Xaman is not configured. */
export function getWalletTransactionRequests(): WalletTransactionRequests {
  const store = globalThis as unknown as Record<symbol, WalletTransactionRequests | undefined>;
  store[SHARED_KEY] ??= createWalletTransactionRequests(undefined, undefined, undefined);
  return store[SHARED_KEY];
}
