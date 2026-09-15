#!/bin/sh
set -eu

base_url="${BASE_URL:-http://localhost:${HOST_PORT:-3001}}"
idempotency_key="checkout-demo-$(date +%s)"

echo "Waiting for the seeded API..."
attempts=0
until curl --silent --fail "${base_url}/health" >/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "API did not become ready at ${base_url}. Set BASE_URL to the published host port." >&2
    exit 1
  fi
  sleep 1
done

echo "Alice checks out book-001 through the leader..."
curl --fail --silent --show-error -X POST "${base_url}/checkouts" \
  -H "Idempotency-Key: ${idempotency_key}" \
  -H 'content-type: application/json' \
  -d '{"personId":"person-001","bookId":"book-001"}'
printf '\n\n'

echo "The replica still says the book is available..."
curl --silent --show-error "${base_url}/books/book-001"
printf '\n\n'

echo "Bob tries to check out the same book; the leader rejects it..."
curl --silent --show-error -X POST "${base_url}/checkouts" \
  -H "Idempotency-Key: checkout-bob-$(date +%s)" \
  -H 'content-type: application/json' \
  -d '{"personId":"person-002","bookId":"book-001"}'
printf '\n\n'
