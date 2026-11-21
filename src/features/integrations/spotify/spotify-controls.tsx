"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import type { SpotifyCallbackResult, SpotifyVisibility } from "@/contracts/integrations";
import { requestJson } from "@/features/events/api-client";
import { notice, secondaryButton } from "@/features/wallet/styles";

/**
 * The interactive parts of the Spotify panel (XRPL-092): the outcome of a connect attempt, who
 * can see the now-playing status, and disconnect. No token ever reaches this code.
 */

const RESULTS = new Map<SpotifyCallbackResult, { tone: keyof typeof notice; text: string }>([
  [
    "connected",
    {
      tone: "positive",
      text: "Spotify is connected. Only you can see what you're listening to until you choose otherwise.",
    },
  ],
  ["denied", { tone: "caution", text: "Spotify wasn't connected because the request wasn't approved." }],
  [
    "invalid_state",
    {
      tone: "critical",
      text: "That Spotify sign-in couldn't be verified, so nothing was connected. Please try again.",
    },
  ],
  ["signed_out", { tone: "caution", text: "You were signed out before Spotify finished. Sign in and try again." }],
  ["failed", { tone: "critical", text: "Spotify couldn't be connected right now. Nothing was saved. Please try again." }],
]);

/** Shows what happened when Spotify sent the browser back (`?spotify=…`). */
export function SpotifyResultNotice({ connected }: { connected: boolean }) {
  const result = useSearchParams().get("spotify") as SpotifyCallbackResult | null;
  const entry = result ? RESULTS.get(result) : undefined;
  // "connected" is only true while it still is, e.g. not after a disconnect on the same page.
  if (!entry || (result === "connected" && !connected)) return null;
  return (
    <p role={entry.tone === "critical" ? "alert" : "status"} className={`mt-4 ${notice[entry.tone]}`}>
      {entry.text}
    </p>
  );
}

const OPTIONS: { value: SpotifyVisibility; label: string; hint: string }[] = [
  { value: "ONLY_ME", label: "Only me", hint: "Nobody else can see what you're listening to." },
  { value: "FRIENDS", label: "My friends", hint: "Accepted friends only." },
  {
    value: "EVERYONE",
    label: "Everyone",
    hint: "Anyone who can see your profile, signed in or not. If your profile is private, that is accepted friends only.",
  },
];

export function SpotifyControls({ initialVisibility }: { initialVisibility: SpotifyVisibility }) {
  const router = useRouter();
  const groupName = useId();
  const [visibility, setVisibility] = useState(initialVisibility);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "positive" | "critical"; text: string } | null>(null);

  async function choose(next: SpotifyVisibility) {
    if (pending || next === visibility) return;
    const previous = visibility;
    setVisibility(next);
    setPending(true);
    setMessage(null);

    const result = await requestJson<{ visibility: SpotifyVisibility }>("/api/integrations/spotify", {
      method: "PATCH",
      body: { visibility: next },
    });
    setPending(false);

    if (!result.ok) {
      // Revert so the control never claims a setting that was not stored.
      setVisibility(previous);
      setMessage({ tone: "critical", text: result.message });
      return;
    }
    setMessage({ tone: "positive", text: "Saved." });
    router.refresh();
  }

  async function disconnect() {
    if (pending) return;
    setPending(true);
    setMessage(null);

    const result = await requestJson<{ connected: boolean }>("/api/integrations/spotify", { method: "DELETE" });
    setPending(false);

    if (!result.ok) {
      setMessage({ tone: "critical", text: result.message });
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-5 flex flex-col gap-5">
      <fieldset className="border-t border-border pt-4">
        <legend className="text-sm font-medium">Who can see what I&apos;m listening to</legend>
        <div className="mt-3 flex flex-col gap-3">
          {OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={visibility === option.value}
                onChange={() => void choose(option.value)}
                disabled={pending}
                className="mt-1 size-4"
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="block text-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {message ? (
        <p role={message.tone === "critical" ? "alert" : "status"} className={notice[message.tone]}>
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => void disconnect()}
          disabled={pending}
          className={`min-h-11 self-start ${secondaryButton}`}
        >
          Disconnect Spotify
        </button>
        <p className="text-sm text-muted">
          Disconnecting deletes the access we hold and stops showing your music. To also remove this app
          from your Spotify account, use{" "}
          <a
            href="https://www.spotify.com/account/apps/"
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent underline"
          >
            Spotify&apos;s app settings
          </a>
          .
        </p>
      </div>
    </div>
  );
}
