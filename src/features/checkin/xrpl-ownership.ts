/**
 * Adapts Agent B's XRPL read service (`XrplQueryService.verifyOwner`, XRPL-007) to the
 * check-in `LedgerOwnership` port.
 *
 * Uses `verifyOwner` (rippled `account_nfts`) rather than `getOwner` (Clio `nft_info`):
 * at the gate we already know which wallet should hold the ticket, and it works without
 * a Clio node.
 *
 * Fails closed: any error, or a read that is not from a validated ledger, becomes
 * LedgerUnavailableError, so the attendee is never admitted on a guess.
 */
import type { LedgerOwnership, OwnershipCheck } from "./ports";
import { LedgerUnavailableError } from "./ports";

/** The part of Agent B's service this adapter needs (structural, so either side can evolve). */
export type OwnerVerifier = {
  verifyOwner(
    nftokenId: string,
    address: string,
  ): Promise<{ owns: boolean; provenance: { ledgerIndex: number | null; validated: boolean } }>;
};

export class XrplLedgerOwnership implements LedgerOwnership {
  constructor(private readonly xrpl: OwnerVerifier) {}

  async checkOwner(nftokenId: string, address: string): Promise<OwnershipCheck> {
    let result: Awaited<ReturnType<OwnerVerifier["verifyOwner"]>>;
    try {
      result = await this.xrpl.verifyOwner(nftokenId, address); // sync throws are caught too
    } catch (err) {
      throw new LedgerUnavailableError(err instanceof Error ? err.message : "XRPL read failed");
    }
    if (!result.provenance.validated) throw new LedgerUnavailableError("Ownership read was not from a validated ledger");
    return { owns: result.owns, ledgerIndex: result.provenance.ledgerIndex };
  }
}

/** Used until the XRPL read service is wired in: every ownership check reports unavailable (503). */
export const unavailableLedger: LedgerOwnership = {
  async checkOwner() {
    throw new LedgerUnavailableError("XRPL ownership checks are not connected yet");
  },
};
