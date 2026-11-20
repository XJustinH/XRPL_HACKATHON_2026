"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { TicketTierInput, type EventView, type TicketTierView } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { requestJson } from "./api-client";
import { dropsToXrpInput, formatXrp, xrpToDrops } from "./event-formatting";

/**
 * Ticket tier management for an event (XRPL-016).
 *
 * Sellers enter prices in XRP; the value is converted to integer drops before
 * it leaves the browser. Every rule shown here is also enforced server-side —
 * a locked tier's price is rejected by the API whatever this form allows.
 */

type Draft = { name: string; description: string; priceXrp: string; quantity: string };

const emptyDraft: Draft = { name: "", description: "", priceXrp: "", quantity: "" };

type FieldErrors = Partial<Record<"name" | "priceXrp" | "quantity", string>>;

/** Validates a draft and converts it to the contract's tier input. */
export function draftToTierInput(
  draft: Draft,
): { ok: true; value: TicketTierInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};

  if (!draft.name.trim()) errors.name = "Tier name is required";

  const price = xrpToDrops(draft.priceXrp);
  if (!price.ok) errors.priceXrp = price.message;

  const quantityText = draft.quantity.trim();
  if (!quantityText) {
    errors.quantity = "Quantity is required";
  } else if (!/^\d+$/.test(quantityText)) {
    // Rejected here rather than by Number(): "1e3" and "2.5" both parse.
    errors.quantity = "Enter a whole number of tickets";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = TicketTierInput.safeParse({
    name: draft.name,
    description: draft.description,
    priceDrops: price.ok ? price.drops : "0",
    totalSupply: Number(quantityText),
    sortOrder: 0,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "totalSupply") errors.quantity ??= issue.message;
      else if (key === "priceDrops") errors.priceXrp ??= issue.message;
      else if (key === "name") errors.name ??= issue.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, value: parsed.data };
}

function TierRow({
  tier,
  eventId,
  onChanged,
  onError,
}: {
  tier: TicketTierView;
  eventId: string;
  onChanged: (event: EventView) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const rowId = useId();
  const router = useRouter();

  const [draft, setDraft] = useState<Draft>({
    name: tier.name,
    description: tier.description,
    priceXrp: dropsToXrpInput(tier.priceDrops),
    quantity: String(tier.totalSupply),
  });

  async function save() {
    const validated = draftToTierInput(draft);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setPending(true);

    // A locked tier may still have its name and description corrected.
    const body = tier.locked
      ? { name: validated.value.name, description: validated.value.description }
      : {
          name: validated.value.name,
          description: validated.value.description,
          priceDrops: validated.value.priceDrops,
          totalSupply: validated.value.totalSupply,
        };

    const result = await requestJson<EventView>(
      `/api/events/${eventId}/tiers/${tier.id}`,
      { method: "PATCH", body },
    );
    setPending(false);

    if (!result.ok) {
      onError(result.message);
      return;
    }
    setEditing(false);
    onChanged(result.data);
    router.refresh();
  }

  async function remove() {
    setPending(true);
    const result = await requestJson<EventView>(
      `/api/events/${eventId}/tiers/${tier.id}`,
      { method: "DELETE" },
    );
    setPending(false);

    if (!result.ok) {
      onError(result.message);
      return;
    }
    onChanged(result.data);
    router.refresh();
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base aria-invalid:border-critical";

  if (!editing) {
    return (
      <li className="rounded-card border border-border bg-canvas p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">{tier.name}</h4>
              {tier.locked ? <Badge tone="caution">Minted — price fixed</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              {formatXrp(tier.priceDrops)} · {tier.totalSupply}{" "}
              {tier.totalSupply === 1 ? "ticket" : "tickets"}
              {tier.mintedQuantity > 0 ? <> · {tier.mintedQuantity} minted</> : null}
            </p>
            {tier.description ? (
              <p className="mt-1 text-sm text-muted">{tier.description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={pending || tier.mintedQuantity > 0}
              title={
                tier.mintedQuantity > 0
                  ? "Tickets have been minted for this tier"
                  : undefined
              }
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-card border border-accent bg-canvas p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`${rowId}-name`} className="block text-sm font-medium">
            Tier name
          </label>
          <input
            id={`${rowId}-name`}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${rowId}-name-error` : undefined}
            className={inputClass}
          />
          {errors.name ? (
            <p id={`${rowId}-name-error`} className="mt-1 text-sm text-critical">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor={`${rowId}-price`} className="block text-sm font-medium">
            Price in XRP
          </label>
          <input
            id={`${rowId}-price`}
            value={draft.priceXrp}
            onChange={(e) => setDraft({ ...draft, priceXrp: e.target.value })}
            disabled={tier.locked}
            inputMode="decimal"
            aria-invalid={errors.priceXrp ? true : undefined}
            aria-describedby={errors.priceXrp ? `${rowId}-price-error` : undefined}
            className={`${inputClass} disabled:opacity-60`}
          />
          {tier.locked ? (
            <p className="mt-1 text-sm text-muted">
              Fixed: tickets for this tier are already on the ledger.
            </p>
          ) : null}
          {errors.priceXrp ? (
            <p id={`${rowId}-price-error`} className="mt-1 text-sm text-critical">
              {errors.priceXrp}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor={`${rowId}-quantity`} className="block text-sm font-medium">
            Quantity
          </label>
          <input
            id={`${rowId}-quantity`}
            value={draft.quantity}
            onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            inputMode="numeric"
            aria-invalid={errors.quantity ? true : undefined}
            aria-describedby={errors.quantity ? `${rowId}-quantity-error` : undefined}
            className={inputClass}
          />
          {errors.quantity ? (
            <p id={`${rowId}-quantity-error`} className="mt-1 text-sm text-critical">
              {errors.quantity}
            </p>
          ) : null}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={`${rowId}-description`} className="block text-sm font-medium">
            Description
          </label>
          <input
            id={`${rowId}-description`}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save tier"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setErrors({});
          }}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}

export function TierManager({ event: initialEvent }: { event: EventView }) {
  const router = useRouter();
  const [event, setEvent] = useState(initialEvent);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const addId = useId();

  const totalSupply = event.tiers.reduce((sum, tier) => sum + tier.totalSupply, 0);

  async function addTier(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (pending) return;
    setFormError(null);

    const result = draftToTierInput(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setPending(true);

    const response = await requestJson<EventView>(`/api/events/${event.id}/tiers`, {
      method: "POST",
      body: result.value,
    });
    setPending(false);
    if (!response.ok) {
      setFormError(response.message);
      return;
    }
    setEvent(response.data);
    setDraft(emptyDraft);
    router.refresh();
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base aria-invalid:border-critical";

  return (
    <section aria-labelledby="tiers-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="tiers-heading" className="text-lg font-semibold">
          Ticket tiers
        </h2>
        {event.tiers.length > 0 ? (
          <p className="text-sm text-muted">
            {event.tiers.length} {event.tiers.length === 1 ? "tier" : "tiers"} ·{" "}
            {totalSupply} {totalSupply === 1 ? "ticket" : "tickets"} total
          </p>
        ) : null}
      </div>

      {formError ? (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical"
        >
          {formError}
        </p>
      ) : null}

      {event.tiers.length === 0 ? (
        <p className="mb-4 rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
          No tiers yet. Add at least one before publishing, so buyers have something to
          buy.
        </p>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {event.tiers.map((tier) => (
            <TierRow
              key={tier.id}
              tier={tier}
              eventId={event.id}
              onChanged={setEvent}
              onError={setFormError}
            />
          ))}
        </ul>
      )}

      <form
        noValidate
        onSubmit={addTier}
        aria-labelledby={`${addId}-heading`}
        className="rounded-card border border-border bg-surface-raised p-5"
      >
        <h3 id={`${addId}-heading`} className="text-sm font-semibold">
          Add a tier
        </h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={`${addId}-name`} className="block text-sm font-medium">
              Tier name <span className="text-muted">(required)</span>
            </label>
            <input
              id={`${addId}-name`}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="General admission"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? `${addId}-name-error` : undefined}
              className={inputClass}
            />
            {errors.name ? (
              <p id={`${addId}-name-error`} className="mt-1 text-sm text-critical">
                {errors.name}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor={`${addId}-price`} className="block text-sm font-medium">
              Price in XRP <span className="text-muted">(required)</span>
            </label>
            <input
              id={`${addId}-price`}
              value={draft.priceXrp}
              onChange={(e) => setDraft({ ...draft, priceXrp: e.target.value })}
              inputMode="decimal"
              placeholder="25"
              aria-invalid={errors.priceXrp ? true : undefined}
              aria-describedby={errors.priceXrp ? `${addId}-price-error` : undefined}
              className={inputClass}
            />
            {errors.priceXrp ? (
              <p id={`${addId}-price-error`} className="mt-1 text-sm text-critical">
                {errors.priceXrp}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted">Use 0 for a free tier.</p>
            )}
          </div>

          <div>
            <label htmlFor={`${addId}-quantity`} className="block text-sm font-medium">
              Quantity <span className="text-muted">(required)</span>
            </label>
            <input
              id={`${addId}-quantity`}
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
              inputMode="numeric"
              placeholder="100"
              aria-invalid={errors.quantity ? true : undefined}
              aria-describedby={errors.quantity ? `${addId}-quantity-error` : undefined}
              className={inputClass}
            />
            {errors.quantity ? (
              <p id={`${addId}-quantity-error`} className="mt-1 text-sm text-critical">
                {errors.quantity}
              </p>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={`${addId}-description`} className="block text-sm font-medium">
              Description
            </label>
            <input
              id={`${addId}-description`}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Standing, doors 19:00"
              className={inputClass}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add tier"}
        </button>
      </form>
    </section>
  );
}
