#!/usr/bin/env bash
# Runs on the VPS (piped over ssh by .semaphore/semaphore.yml). Pulls both repos,
# installs dependencies, restarts sama-backend, and waits for /api/health.
set -euo pipefail

SAMA_DIR="${SAMA_DIR:-$HOME/sama}"
BUN="${BUN:-/usr/local/bin/bun}"

echo "==> sama-packages"
cd "$SAMA_DIR/sama-packages"
git pull --ff-only
"$BUN" install

echo "==> sama-backend"
cd "$SAMA_DIR/sama-backend"
git pull --ff-only
"$BUN" install

echo "==> restart sama-backend"
sudo systemctl restart sama-backend.service

echo "==> health"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3300/api/health; then
    echo
    echo "deploy ok: $(git -C "$SAMA_DIR/sama-backend" rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

echo "health check failed; recent logs:" >&2
sudo journalctl -u sama-backend -n 40 --no-pager >&2
exit 1
