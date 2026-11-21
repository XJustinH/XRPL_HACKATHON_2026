"use client";

import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";

import {
  DEFAULT_RIGHTS_STATEMENT,
  MAX_EDITION_SIZE,
  MEDIA_ACCEPT,
  MEDIA_SUPPORTED_SUMMARY,
  RIGHTS_DECLARATION,
  type CollectibleMintResult,
  type CollectibleRequestResult,
  type CollectibleTokenView,
  type CollectibleView,
  type MediaAssetView,
} from "@/contracts/collectibles";
import type { TransactionRequest } from "@/contracts/xrpl";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { xrpToDrops } from "@/features/events/event-formatting";
import { card, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { TransactionApproval } from "@/features/wallet/transaction-approval";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

import { callApi, checkMediaFile, postJson, uploadMedia } from "./client-api";
import { MediaPreview, TokenProof, tokenStatusLabel } from "./collectible-ui";

const field = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const labelText = "mb-1 block text-sm font-medium";

type FormPhase =
  | { name: "idle" }
  | { name: "uploading"; percent: number }
  | { name: "saving" }
  | { name: "error"; message: string };

/**
 * Upload media with the rights declaration, then describe it as a draft collectible
 * (XRPL-070/072). The upload reports progress, invalid files and failed storage.
 */
function NewCollectibleForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  /** Kept after a successful upload, so a failed save does not upload the file again. */
  const [uploaded, setUploaded] = useState<MediaAssetView | null>(null);
  const [rights, setRights] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [editionSize, setEditionSize] = useState("10");
  const [priceXrp, setPriceXrp] = useState("");
  const [rightsStatement, setRightsStatement] = useState(DEFAULT_RIGHTS_STATEMENT);
  const [phase, setPhase] = useState<FormPhase>({ name: "idle" });
  const [formKey, setFormKey] = useState(0);
  const busy = phase.name === "uploading" || phase.name === "saving";
  const fail = (message: string) => setPhase({ name: "error", message });

  const chooseFile = (next: File | null) => {
    setFile(next);
    setUploaded(null);
    const problem = next ? checkMediaFile(next) : null;
    setPhase(problem ? { name: "error", message: problem } : { name: "idle" });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return fail("Choose an image, audio or video file to upload.");
    const problem = checkMediaFile(file);
    if (problem) return fail(problem);
    if (!rights) return fail("Confirm that you hold the rights to this content before uploading it.");
    if (!title.trim()) return fail("Give the collectible a title.");
    const editions = Number(editionSize);
    if (!Number.isInteger(editions) || editions < 1 || editions > MAX_EDITION_SIZE) {
      return fail(`The edition size must be a whole number from 1 to ${MAX_EDITION_SIZE}.`);
    }
    const price = xrpToDrops(priceXrp);
    if (!price.ok) return fail(price.message);
    if (price.drops === "0") return fail("Set a price above 0 XRP.");

    try {
      let media = uploaded;
      if (!media) {
        setPhase({ name: "uploading", percent: 0 });
        media = await uploadMedia(file, (percent) => setPhase({ name: "uploading", percent }));
        setUploaded(media);
      }
      setPhase({ name: "saving" });
      await postJson<CollectibleView>("/api/collectibles", {
        mediaAssetId: media.id,
        title: title.trim(),
        description: description.trim(),
        editionSize: editions,
        priceDrops: price.drops,
        rightsStatement: rightsStatement.trim() || undefined,
      });
      await onCreated();
      setFile(null);
      setUploaded(null);
      setRights(false);
      setTitle("");
      setDescription("");
      setPriceXrp("");
      setRightsStatement(DEFAULT_RIGHTS_STATEMENT);
      setFormKey((key) => key + 1);
      setPhase({ name: "idle" });
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not save the collectible.");
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className={`${card} flex flex-col gap-4`} noValidate>
      <h2 className="text-lg font-semibold">New digital collectible</h2>
      <div>
        <label htmlFor="collectible-file" className={labelText}>
          Media file
        </label>
        <input
          key={formKey}
          id="collectible-file"
          type="file"
          accept={MEDIA_ACCEPT}
          disabled={busy}
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          className="block w-full text-sm"
        />
        <p className="mt-1 text-xs text-muted">{MEDIA_SUPPORTED_SUMMARY}</p>
        {uploaded ? (
          <p className="mt-1 text-xs text-positive">Uploaded: {uploaded.originalName}. It stays private until you publish.</p>
        ) : null}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={rights}
          disabled={busy}
          onChange={(event) => setRights(event.target.checked)}
          className="mt-1"
        />
        <span>{RIGHTS_DECLARATION}</span>
      </label>
      <div>
        <label htmlFor="collectible-title" className={labelText}>
          Title
        </label>
        <input
          id="collectible-title"
          value={title}
          maxLength={120}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          className={field}
        />
      </div>
      <div>
        <label htmlFor="collectible-description" className={labelText}>
          Description
        </label>
        <textarea
          id="collectible-description"
          value={description}
          maxLength={2000}
          rows={3}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
          className={field}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="collectible-editions" className={labelText}>
            Edition size (how many NFTs)
          </label>
          <input
            id="collectible-editions"
            inputMode="numeric"
            value={editionSize}
            disabled={busy}
            onChange={(event) => setEditionSize(event.target.value)}
            className={field}
          />
        </div>
        <div>
          <label htmlFor="collectible-price" className={labelText}>
            Price per edition (XRP)
          </label>
          <input
            id="collectible-price"
            inputMode="decimal"
            placeholder="e.g. 5"
            value={priceXrp}
            disabled={busy}
            onChange={(event) => setPriceXrp(event.target.value)}
            className={field}
          />
        </div>
      </div>
      <div>
        <label htmlFor="collectible-rights" className={labelText}>
          What buyers receive
        </label>
        <textarea
          id="collectible-rights"
          value={rightsStatement}
          maxLength={1000}
          rows={3}
          disabled={busy}
          onChange={(event) => setRightsStatement(event.target.value)}
          className={field}
        />
        <p className="mt-1 text-xs text-muted">
          Shown on the listing and stored in the NFT metadata. Buyers are always told that copyright is not
          transferred automatically.
        </p>
      </div>

      {phase.name === "uploading" ? (
        <div role="status" className="text-sm">
          <label htmlFor="collectible-progress">Uploading… {phase.percent}%</label>
          <progress id="collectible-progress" value={phase.percent} max={100} className="mt-1 block w-full" />
        </div>
      ) : null}
      {phase.name === "saving" ? (
        <p role="status" className="text-sm text-muted">
          Saving the draft…
        </p>
      ) : null}
      {phase.name === "error" ? (
        <p role="alert" className={notice.critical}>
          {phase.message}
        </p>
      ) : null}

      <div>
        <button type="submit" disabled={busy} className={`${primaryButton} w-full sm:w-auto`}>
          {uploaded ? "Save draft" : "Upload and save draft"}
        </button>
      </div>
    </form>
  );
}

type Approval = { request: TransactionRequest; tokenId: string; title: string };

/** One collectible: publish it, mint its editions and list them for sale (XRPL-072/073/074). */
function ManageCollectible({
  collectible,
  walletAddress,
  onChanged,
}: {
  collectible: CollectibleView;
  walletAddress: string | null;
  onChanged: () => Promise<void>;
}) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const published = collectible.status === "PUBLISHED";
  const mintable = collectible.tokens.some((t) => t.mintStatus === "NOT_MINTED" || t.mintStatus === "FAILED");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const publish = () =>
    run(async () => {
      await postJson<CollectibleView>(`/api/collectibles/${collectible.id}`, { status: "PUBLISHED" }, "PATCH");
      await onChanged();
    });

  const mint = () =>
    run(async () => {
      const result = await postJson<CollectibleMintResult>(`/api/collectibles/${collectible.id}/mint-intent`);
      setWarning(
        result.metadataPublic
          ? null
          : "This server's address is not public, so wallets and explorers can't show the collectible's details. The mint itself is valid.",
      );
      setApproval({
        request: result.request,
        tokenId: result.token.id,
        title: `Approve the mint: ${collectible.title} #${result.token.edition} of ${collectible.editionSize}`,
      });
      await onChanged();
    });

  const listForSale = (token: CollectibleTokenView) =>
    run(async () => {
      const result = await postJson<CollectibleRequestResult>(`/api/collectibles/tokens/${token.id}/sale-intent`);
      setApproval({
        request: result.request,
        tokenId: token.id,
        title: `Approve the sale listing: #${token.edition} for ${formatDropsAsXrp(result.amountDrops)} XRP`,
      });
      await onChanged();
    });

  /** The approval finished either way: read the result back from the server, never from the browser. */
  const settle = (tokenId: string) =>
    run(async () => {
      await callApi<CollectibleTokenView>(`/api/collectibles/tokens/${tokenId}`);
      await onChanged();
    });

  return (
    <li className={`${card} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{collectible.title}</h3>
            <Badge tone={published ? "positive" : "neutral"}>{published ? "Published" : "Draft"}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            Edition of {collectible.editionSize} · {formatDropsAsXrp(collectible.priceDrops)} XRP each ·{" "}
            {collectible.mintedCount} minted · {collectible.forSaleCount} for sale
          </p>
        </div>
        {published ? (
          <Link href={`/collectibles/${collectible.id}`} className={secondaryButton}>
            View listing
          </Link>
        ) : null}
      </div>
      <MediaPreview media={collectible.media} title={collectible.title} compact />

      {!published ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            A draft and its media are visible only to you. Publishing makes the listing, the media and the NFT
            metadata public, and fixes the title, description, edition size and rights statement.
          </p>
          <div>
            <button type="button" disabled={busy} onClick={() => void publish()} className={primaryButton}>
              Publish
            </button>
          </div>
        </div>
      ) : !walletAddress ? (
        <p className={notice.caution}>
          Connect your Xaman wallet to mint and sell this collectible.{" "}
          <Link href="/connect" className="font-semibold underline">
            Connect wallet
          </Link>
        </p>
      ) : mintable ? (
        <div>
          <button type="button" disabled={busy} onClick={() => void mint()} className={primaryButton}>
            Mint next edition
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className={notice.critical}>
          {error}
        </p>
      ) : null}
      {warning ? <p className={notice.caution}>{warning}</p> : null}
      {approval ? (
        <TransactionApproval
          key={approval.request.id}
          request={approval.request}
          title={approval.title}
          onFinished={() => void settle(approval.tokenId)}
        />
      ) : null}

      {published ? (
        <ul className="flex flex-col divide-y divide-border">
          {collectible.tokens.map((token) => {
            const canList =
              !!walletAddress &&
              token.mintStatus === "MINTED" &&
              token.saleStatus === "NONE" &&
              (token.offerStatus === "NONE" || token.offerStatus === "FAILED" || token.offerStatus === "STALE");
            return (
              <li key={token.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    #{token.edition} of {token.editionSize} · {tokenStatusLabel(token)}
                  </p>
                  <TokenProof token={token} />
                </div>
                {canList ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void listForSale(token)}
                    className={`${secondaryButton} shrink-0`}
                  >
                    List for {formatDropsAsXrp(collectible.priceDrops)} XRP
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The seller's collectibles workspace: upload and describe media, publish, mint each edition in
 * their own Xaman wallet, and list minted editions for sale. Every result shown is read back
 * from the server, which records it only from a validated ledger transaction.
 */
export function SellerCollectiblesManager({
  initial,
  walletAddress,
}: {
  initial: CollectibleView[];
  walletAddress: string | null;
}) {
  const [items, setItems] = useState(initial);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await callApi<CollectibleView[]>("/api/collectibles"));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not reload your collectibles.");
    }
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <NewCollectibleForm onCreated={refresh} />
      <section aria-labelledby="my-collectibles-heading">
        <h2 id="my-collectibles-heading" className="mb-4 text-lg font-semibold">
          Your collectibles
        </h2>
        {loadError ? (
          <p role="alert" className={`${notice.critical} mb-4`}>
            {loadError}
          </p>
        ) : null}
        {items.length === 0 ? (
          <EmptyState
            title="No collectibles yet"
            description="Upload an image, a track or a clip above to create your first digital collectible."
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {items.map((collectible) => (
              <ManageCollectible
                key={collectible.id}
                collectible={collectible}
                walletAddress={walletAddress}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
