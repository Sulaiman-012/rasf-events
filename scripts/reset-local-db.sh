#!/usr/bin/env sh
# Wipes the LOCAL test database (never touches Cloudflare) and re-applies migrations.
set -e
cd "$(dirname "$0")/.."
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply DB --local
