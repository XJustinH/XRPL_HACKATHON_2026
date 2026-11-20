"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DemoPersona } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { postJson } from "./post-json";
import { ROLE_HOME, ROLE_LABEL } from "./roles";

/** Lets judges and teammates switch between seeded demo accounts without a wallet. */
export function DemoPersonaList({
  personas,
  currentUserId = null,
}: {
  personas: DemoPersona[];
  currentUserId?: string | null;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (personas.length === 0) {
    return (
      <p className="text-sm text-muted">
        No demo accounts have been added yet. They appear here once the demo data is seeded.
      </p>
    );
  }

  async function continueAs(persona: DemoPersona) {
    setError(null);
    setPendingId(persona.userId);
    const result = await postJson("/api/auth/demo-session", { userId: persona.userId });
    if (!result.ok) {
      setError(result.message);
      setPendingId(null);
      return;
    }
    router.push(ROLE_HOME[persona.role]);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {personas.map((persona) => {
          const isCurrent = persona.userId === currentUserId;
          return (
            <li
              key={persona.userId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-raised px-4 py-3"
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium">{persona.displayName}</span>
                <Badge tone={persona.role === "CUSTOMER" ? "neutral" : "accent"}>{ROLE_LABEL[persona.role]}</Badge>
              </span>
              <button
                type="button"
                onClick={() => continueAs(persona)}
                disabled={pendingId !== null || isCurrent}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-60"
              >
                {isCurrent ? "Signed in" : pendingId === persona.userId ? "Switching…" : `Continue as ${persona.displayName}`}
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
