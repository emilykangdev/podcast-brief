#!/usr/bin/env bash
# Writes a test env file for CI by combining the running local Supabase instance's actual
# keys (pulled live via `supabase status`, never hardcoded — those values trip GitHub's
# secret-scanning push protection even though they're fixed public CLI defaults) with the
# static dummy values documented in .env.test.example.
#
# Usage: ./scripts/ci/write-test-env.sh <output-file>  (e.g. .env.test.local or .env.local)
set -euo pipefail

OUT="${1:?usage: write-test-env.sh <output-file>}"

supabase status -o env \
  --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.publishable_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
  --override-name auth.secret_key=SUPABASE_SECRET_KEY \
  --override-name db.url=SUPABASE_DB_URL \
  | grep -E '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY|SUPABASE_SECRET_KEY|SUPABASE_DB_URL)=' \
  > "$OUT"

cat >> "$OUT" <<'EOF'
APP_ENV=DEVELOPMENT
NEXT_PUBLIC_DOMAIN_NAME=localhost:3000
ARCJET_KEY=ajkey_test_fixture_only_not_a_real_key
STRIPE_SECRET_KEY=sk_test_fixture_only_not_a_real_key
STRIPE_WEBHOOK_SECRET=whsec_fixture_only_not_a_real_secret
NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS=price_test_5credits
NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS=price_test_15credits
NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS=price_test_50credits
EOF
