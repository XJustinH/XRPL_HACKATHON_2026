import { CreateResaleOfferBody } from "@/contracts/xrpl";
import { holderOfferRoute } from "@/lib/xrpl/offers/holder-route";

/**
 * POST /api/tickets/:id/resale-offers: the ticket's holder lists it for resale at their price
 * (XRPL-036). Body `{ amountDrops }`. An open `NFTokenCreateOffer` (sell) for the holder to approve
 * in Xaman. The app lists it publicly only while the resale rule allows (XRPL-037).
 * 401 without a session · 403 WALLET_NOT_VERIFIED · 404 unknown ticket · 409 not the holder, not yet
 * sold on primary, checked in, event finished, already offered, or above the resale price cap.
 */
export const POST = holderOfferRoute("POST /api/tickets/:id/resale-offers", CreateResaleOfferBody, (b) => ({
  kind: "RESALE",
  amountDrops: b.amountDrops,
}));
