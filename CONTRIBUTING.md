# Contributing

## Branches

- Never push to `main`. All changes land through a pull request.
- One branch per issue, named `<type>/xrpl-###-what-it-does`, e.g. `feat/xrpl-024-mint-ticket-nft` or
  `fix/xrpl-012-reject-replayed-signin`. `<type>` matches the commit types below. Do not name branches after
  people or agents.
  Use the planning ID (`XRPL-###`) from the issue title.
- Keep branches short-lived and rebase/merge from `main` before opening a dependent PR.
- No force-pushes to shared branches.

## Commits

Conventional style with the planning ID:

```
feat(nft): mint tickets on XRPL Testnet (XRPL-024)
fix(auth): reject replayed sign-in nonce (XRPL-012)
chore(db): add check-in uniqueness constraint (XRPL-005)
docs(readme): document Testnet setup (XRPL-053)
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`. Keep commits focused, with no drive-by reformatting.
Commit under your own Git identity.

## Pull requests

- Title like the commit subject. The body lists the issue(s), what changed, the test commands you ran
  and their results, any validated Testnet tx hashes, and the risks or limitations. Use the PR template.
- Link the issue with `Closes #<github-number>` only when every acceptance criterion is met.
- CI must pass and one teammate must review before merge.
- Do not mark an on-chain action as done without a validated (`tesSUCCESS`) Testnet transaction.

## Ownership

Each directory has one owning agent/person. See the README in each `src/` folder and
[docs/CLAUDE_AGENT_HANDOFFS.md](docs/CLAUDE_AGENT_HANDOFFS.md).

- **Database schema and migrations (`prisma/`)** belong to Agent A. To add or change a model, open an
  issue or PR comment titled `Schema request: …` describing the fields, constraints and the issue it
  unblocks. Do not create migrations on feature branches.
- **Shared contracts (`src/contracts/`)**: feature owners write `src/contracts/<domain>.ts`, and Agent A approves
  exports from `src/contracts/index.ts`. Merge contract changes before the code that consumes them.
- **XRPL / wallet code (`src/lib/xrpl/`)** belongs to Agent B. Other code calls B's typed functions and never
  imports `xrpl` or the wallet SDK directly.
- **CI, e2e tests, seed and demo scripts (`.github/workflows/`, `tests/`, `scripts/`)** belong to Agent E.

## Before you open a PR

```bash
npm run typecheck
npm run lint
npm test            # unit tests
npm run test:db     # schema integration tests (needs `npm run db:up`)
npm run build
```

## Secrets

Never commit `.env`, seeds, private keys, API secrets or tokens. Only `.env.example` with blank
placeholders is tracked. Secrets are server-only, so never prefix them with `NEXT_PUBLIC_`.
If you commit a secret by accident, rotate it immediately. Removing it from history is not enough.
