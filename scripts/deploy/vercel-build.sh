#!/usr/bin/env bash
# Vercel build command for every preview and production deployment (XRPL-009).
# Configured in vercel.json. Setup and variables: docs/ci-and-deployment.md.
#
# 1. Check the deployment's environment variables, so a bad config fails the build.
# 2. Apply committed migrations to this deployment's database.
# 3. Insert the labelled demo data when SEED_DEMO_DATA=true (idempotent).
# 4. Build the app.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set for this Vercel environment. Connect the Neon integration or add it in Project Settings." >&2
  exit 1
fi

echo "==> Checking environment"
npx tsx scripts/deploy/check-env.ts

# Prisma's migration commands need a direct connection: a pooled URL can't hold the migration
# lock. The Neon integration provides the direct one as DATABASE_URL_UNPOOLED.
direct_url="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"

echo "==> Applying migrations"
DATABASE_URL="$direct_url" npm run db:deploy

if [ "${SEED_DEMO_DATA:-}" = "true" ]; then
  echo "==> Seeding demo data (SEED_DEMO_DATA=true)"
  DATABASE_URL="$direct_url" npm run db:seed -- --allow-production
fi

echo "==> Building"
npm run build
