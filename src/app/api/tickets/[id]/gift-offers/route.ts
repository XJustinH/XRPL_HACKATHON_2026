import { CreateGiftOfferBody } from "@/contracts/xrpl";
import { holderOfferRoute } from "@/lib/xrpl/offers/holder-route";

/**
 * POST /api/tickets/:id/gift-offers: the ticket's holder gives it to one named wallet (XRPL-041).
 * Body `{ destination }`. A zero-price `NFTokenCreateOffer` with `Destination`: only that wallet can
 * accept it, and once accepted the transfer can't be undone. Same errors as the private-offer route.
 */
export const POST = holderOfferRoute("POST /api/tickets/:id/gift-offers", CreateGiftOfferBody, (b) => ({
  kind: "GIFT",
  destination: b.destination,
}));
