// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

const getOfferStatus = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/offers/purchase", () => ({
  getOfferStatus: (...args: unknown[]) => getOfferStatus(...args),
}));

const { GET } = await import("./route");

const OFFER = "7be7283c-71b8-47bf-89f0-a0d8183492da";
const ctx = (id = OFFER) => ({ params: Promise.resolve({ id }) });
const get = () => new Request(`http://localhost/api/offers/${OFFER}`);

describe("GET /api/offers/:id", () => {
  beforeEach(() => {
    getOfferStatus.mockReset();
  });

  it("returns the offer after reconciling purchases, uncached", async () => {
    getOfferStatus.mockResolvedValue({
      offer: { id: OFFER, state: "ACCEPTED" },
      soldAt: "2026-11-20T22:00:00.000Z",
    });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ offer: { state: "ACCEPTED" } });
    expect(getOfferStatus).toHaveBeenCalledWith({ db: "db" }, OFFER);
  });

  it("answers 404 for a malformed or unknown offer and 503 when the ledger is unreachable", async () => {
    expect((await GET(get(), ctx("nope"))).status).toBe(404);
    getOfferStatus.mockRejectedValueOnce(errors.notFound("Offer not found"));
    expect((await GET(get(), ctx())).status).toBe(404);
    getOfferStatus.mockRejectedValueOnce(new XrplServiceError("NODE_UNAVAILABLE", "No XRPL node reachable"));
    expect((await GET(get(), ctx())).status).toBe(503);
  });
});
