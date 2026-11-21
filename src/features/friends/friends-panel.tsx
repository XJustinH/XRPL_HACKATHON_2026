"use client";

/**
 * Friends (XRPL-084): your friend code, add by code, requests both ways, friends, blocked people and
 * who can see your friend list. Friendships are opt-in: nobody can find you by name, only by a code
 * you choose to share.
 */
import { useCallback, useEffect, useId, useState } from "react";
import type { FriendRequestResult, FriendsOverview, FriendsVisibility } from "@/contracts/friends";
import { requestJson } from "@/features/events/api-client";

type Load = { kind: "loading" } | { kind: "ready"; data: FriendsOverview } | { kind: "error"; message: string };
type Notice = { tone: "ok" | "error"; text: string } | null;

async function loadOverview(): Promise<Load> {
  try {
    const res = await fetch("/api/friends", { credentials: "same-origin", cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { data?: FriendsOverview; error?: { message?: string } } | null;
    if (res.ok && body?.data) return { kind: "ready", data: body.data };
    return { kind: "error", message: body?.error?.message ?? "Couldn't load your friends. Try again shortly." };
  } catch {
    return { kind: "error", message: "Couldn't reach the server. Check your connection and try again." };
  }
}

export function FriendsPanel() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setLoad(await loadOverview()), []);
  useEffect(() => {
    let live = true;
    void loadOverview().then((next) => live && setLoad(next));
    return () => {
      live = false;
    };
  }, []);

  /** Runs one action, shows its outcome, then reloads the lists. */
  async function act(run: () => Promise<{ ok: true; text: string } | { ok: false; message: string }>) {
    setBusy(true);
    setNotice(null);
    const outcome = await run();
    setNotice(outcome.ok ? { tone: "ok", text: outcome.text } : { tone: "error", text: outcome.message });
    await refresh();
    setBusy(false);
  }
  const call = async <T,>(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown, text: (data: T) => string) => {
    const result = await requestJson<T>(url, { method, body });
    return result.ok ? { ok: true as const, text: text(result.data) } : { ok: false as const, message: result.message };
  };

  if (load.kind === "loading") return <p className="text-sm text-muted">Loading your friends…</p>;
  if (load.kind === "error") return <p className="rounded-card border border-border bg-surface px-5 py-4 text-sm text-muted">{load.message}</p>;
  const { data } = load;

  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite">
        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`rounded-lg px-4 py-3 text-sm ${notice.tone === "error" ? "bg-critical-soft text-critical" : "bg-positive-soft text-positive"}`}
          >
            {notice.text}
          </p>
        ) : null}
      </div>

      <Card title="Your friend code">
        <p className="text-sm text-muted">Share it with people you want as friends. Nobody can find you by name.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="break-all rounded-lg bg-surface px-3 py-2 font-mono text-sm">{data.myCode}</code>
          <CopyButton text={data.myCode} />
        </div>
      </Card>

      <AddFriend
        busy={busy}
        onSend={(userId) =>
          act(() =>
            call<FriendRequestResult>("/api/friends/requests", "POST", { userId }, (r) =>
              r.status === "ACCEPTED" ? "You're now friends." : "Friend request sent.",
            ),
          )
        }
      />

      <Card title="Requests for you">
        <PeopleList
          empty="No requests waiting."
          people={data.incoming.map((r) => ({ key: r.requestId, name: r.displayName }))}
          actions={(key) => [
            {
              label: "Accept",
              primary: true,
              run: () => act(() => call(`/api/friends/requests/${key}/respond`, "POST", { accept: true }, () => "You're now friends.")),
            },
            {
              label: "Decline",
              run: () => act(() => call(`/api/friends/requests/${key}/respond`, "POST", { accept: false }, () => "Request declined.")),
            },
          ]}
          busy={busy}
        />
      </Card>

      <Card title="Requests you sent">
        <PeopleList
          empty="No requests waiting for an answer."
          people={data.outgoing.map((r) => ({ key: r.userId, name: r.displayName }))}
          actions={(key) => [
            { label: "Cancel", run: () => act(() => call(`/api/friends/${key}`, "DELETE", undefined, () => "Request cancelled.")) },
          ]}
          busy={busy}
        />
      </Card>

      <Card title="Friends">
        <PeopleList
          empty="No friends yet. Share your code or add someone's."
          people={data.friends.map((f) => ({ key: f.userId, name: f.displayName }))}
          actions={(key) => [
            { label: "Remove", run: () => act(() => call(`/api/friends/${key}`, "DELETE", undefined, () => "Removed from your friends.")) },
            { label: "Block", run: () => act(() => call("/api/friends/blocks", "POST", { userId: key }, () => "Blocked. They can't send you requests.")) },
          ]}
          busy={busy}
        />
      </Card>

      {data.blocked.length > 0 ? (
        <Card title="Blocked">
          <PeopleList
            empty=""
            people={data.blocked.map((b) => ({ key: b.userId, name: b.displayName }))}
            actions={(key) => [
              { label: "Unblock", run: () => act(() => call(`/api/friends/blocks/${key}`, "DELETE", undefined, () => "Unblocked.")) },
            ]}
            busy={busy}
          />
        </Card>
      ) : null}

      <VisibilitySetting
        value={data.friendsVisibility}
        busy={busy}
        onChange={(value) =>
          act(() =>
            call("/api/friends/settings", "PATCH", { friendsVisibility: value }, () =>
              value === "FRIENDS" ? "Your friends can now see your friend list." : "Only you can see your friend list.",
            ),
          )
        }
      />
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

type Action = { label: string; run: () => void; primary?: boolean };

function PeopleList({
  people,
  actions,
  empty,
  busy,
}: {
  people: { key: string; name: string }[];
  actions: (key: string) => Action[];
  empty: string;
  busy: boolean;
}) {
  if (people.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {people.map((p) => (
        <li key={p.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="font-medium">{p.name}</span>
          <span className="flex gap-2">
            {actions(p.key).map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={busy}
                onClick={a.run}
                aria-label={`${a.label} ${p.name}`}
                className={`min-h-11 rounded-lg px-4 text-sm font-semibold disabled:opacity-60 ${
                  a.primary ? "bg-accent text-accent-ink hover:opacity-90" : "border border-border hover:bg-surface"
                }`}
              >
                {a.label}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AddFriend({ busy, onSend }: { busy: boolean; onSend: (userId: string) => void }) {
  const id = useId();
  const [code, setCode] = useState("");
  return (
    <section aria-labelledby={`${id}-h`} className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id={`${id}-h`} className="text-lg font-semibold">
        Add a friend
      </h2>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onSend(code.trim());
        }}
      >
        <label htmlFor={id} className="sr-only">
          Their friend code
        </label>
        <input
          id={id}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Paste their friend code"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 flex-1 rounded-lg border border-border bg-canvas px-3 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="min-h-11 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
        >
          Send request
        </button>
      </form>
    </section>
  );
}

function VisibilitySetting({ value, busy, onChange }: { value: FriendsVisibility; busy: boolean; onChange: (v: FriendsVisibility) => void }) {
  const name = useId();
  const options: { value: FriendsVisibility; label: string }[] = [
    { value: "ONLY_ME", label: "Only me" },
    { value: "FRIENDS", label: "My friends" },
  ];
  return (
    <fieldset className="rounded-card border border-border bg-surface-raised p-5">
      <legend className="px-1 text-lg font-semibold">Who can see your friends</legend>
      <p className="text-sm text-muted">If your profile is private, nobody else can see them either way.</p>
      <div className="mt-3 flex flex-wrap gap-4">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name={name} checked={value === o.value} disabled={busy} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      className="min-h-11 rounded-lg border border-border px-4 text-sm font-semibold hover:bg-surface"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
