import { useCallback, useEffect, useRef, useState } from "react";

import { FINAL_SIGN_REQUEST_STATUSES, type SignRequest } from "@/contracts/xrpl";

export type SignInState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; request: SignRequest }
  | { phase: "finished"; request: SignRequest }
  | { phase: "error"; message: string };

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function callApi(input: string, init?: RequestInit): Promise<SignRequest> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json" },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: SignRequest;
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !body.data) {
    throw new ApiError(body.error?.code ?? "UNKNOWN", body.error?.message ?? `HTTP ${response.status}`);
  }
  return body.data;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE") {
    return "Wallet sign-in isn't available right now. Try again in a moment.";
  }
  return "Something went wrong while talking to the wallet service. Try again.";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * Runs one Xaman sign-in: creates the request, polls until the user answers, and
 * calls `onConnected` when it is signed on the right network. Other outcomes end in
 * the "finished" phase so the UI can explain them.
 */
export function useSignIn({
  onConnected,
  pollIntervalMs = 2000,
}: {
  onConnected: (request: SignRequest & { account: string }) => void;
  pollIntervalMs?: number;
}) {
  const [state, setState] = useState<SignInState>({ phase: "idle" });
  const activeId = useRef<string | null>(null);
  const connected = useRef(onConnected);

  useEffect(() => {
    connected.current = onConnected;
  }, [onConnected]);

  // Stop polling when the component goes away.
  useEffect(() => () => void (activeId.current = null), []);

  const finish = useCallback((request: SignRequest) => {
    activeId.current = null;
    if (request.status === "SIGNED" && request.networkMatches === true && request.account) {
      setState({ phase: "idle" });
      connected.current({ ...request, account: request.account });
    } else {
      setState({ phase: "finished", request });
    }
  }, []);

  const pollUntilAnswered = useCallback(
    async (id: string) => {
      let failures = 0;
      while (activeId.current === id) {
        await sleep(pollIntervalMs);
        if (activeId.current !== id) return;
        try {
          const request = await callApi(`/api/wallet/sign-requests/${id}`);
          if (activeId.current !== id) return;
          failures = 0;
          if (FINAL_SIGN_REQUEST_STATUSES.includes(request.status)) finish(request);
          else setState({ phase: "waiting", request });
        } catch (error) {
          if (activeId.current !== id) return;
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            activeId.current = null;
            setState({ phase: "error", message: messageFor(error) });
          }
        }
      }
    },
    [finish, pollIntervalMs],
  );

  const start = useCallback(async () => {
    activeId.current = null;
    setState({ phase: "starting" });
    try {
      const request = await callApi("/api/wallet/sign-requests", {
        method: "POST",
        body: JSON.stringify({ kind: "SIGN_IN" }),
      });
      activeId.current = request.id;
      setState({ phase: "waiting", request });
      void pollUntilAnswered(request.id);
    } catch (error) {
      setState({ phase: "error", message: messageFor(error) });
    }
  }, [pollUntilAnswered]);

  const cancel = useCallback(async () => {
    const id = activeId.current;
    activeId.current = null;
    if (!id) {
      setState({ phase: "idle" });
      return;
    }
    try {
      // The user may have approved just before cancelling; finish() handles either outcome.
      finish(await callApi(`/api/wallet/sign-requests/${id}`, { method: "DELETE" }));
    } catch {
      setState({ phase: "idle" });
    }
  }, [finish]);

  const reset = useCallback(() => {
    activeId.current = null;
    setState({ phase: "idle" });
  }, []);

  return { state, start, cancel, reset };
}
