"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "./post-json";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    const result = await postJson("/api/auth/logout", {});
    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-60"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
