import { CreatePrivateOfferBody } from "@/contracts/xrpl";
import { holderOfferRoute } from "@/lib/xrpl/offers/holder-route";

/**
 * POST /api/tickets/:id/private-offers: the ticket's holder sells it to one named wallet (XRPL-040).
 * Body `{ destination, amountDrops }`. The `NFTokenCreateOffer` sets `Destination`, so the ledger lets
 * only that wallet accept it. Same errors as the resale route, plus 409 when the recipient is the holder.
 */
export const POST = holderOfferRoute("POST /api/tickets/:id/private-offers", CreatePrivateOfferBody, (b) => ({
  kind: "PRIVATE",
  amountDrops: b.amountDrops,
  destination: b.destination,
}));
