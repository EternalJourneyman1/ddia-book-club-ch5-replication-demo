# Run: Replicated Library Checkout

This demo models a client that writes checkout commands to a primary database but is only allowed to read the replicated database.

```text
POST /checkouts  -> primary, authoritative decision
GET /books/:id   -> replica, possibly stale catalog
```

## Start clean

Always reset the Redis volumes for a fresh run:

```sh
cd /Users/eternal/workspace/message-broker
docker compose down -v
REPLICATION_DELAY_SECONDS=10 HOST_PORT=3001 docker compose up -d --build
```

Check the services:

```sh
docker compose ps
```

Wait until the API is ready and seeded:

```sh
until curl --silent --fail http://localhost:3001/health >/dev/null; do sleep 1; done
```

Watch replication in another terminal:

```sh
docker compose logs -f replicator
```

The seed contains 20 people and 40 available books. The seed is loaded into both stores as the initial baseline. Checkout changes are delayed to the replica.

Use book IDs from `book-001` through `book-040`. The book record is supposed to
already exist in the replica. The stale value is its availability status after a
checkout, not the initial existence of the book. For example, `book-1002` is not
one of the seeded IDs.

## Alice and Bob scenario

The catalog reads from the replica. Initially, `book-001` is available:

```sh
curl http://localhost:3001/books/book-001
```

Alice checks out the book. This write goes to the primary:

```sh
curl -X POST http://localhost:3001/checkouts \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: alice-book-001' \
  -d '{"personId":"person-001","bookId":"book-001"}'
```

Expected response:

```json
{
  "acknowledgedBy": "leader",
  "replicaVisibleAfter": "10 seconds (approximately)"
}
```

Immediately read the catalog. It still comes from the replica, so it may say the book is available:

```sh
curl http://localhost:3001/books/book-001
```

Expected stale response:

```json
{
  "source": "replica",
  "book": {
    "id": "book-001",
    "status": "available"
  }
}
```

Bob sees that stale catalog and tries to check out the same book:

```sh
curl -i -X POST http://localhost:3001/checkouts \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: bob-book-001' \
  -d '{"personId":"person-002","bookId":"book-001"}'
```

The primary rejects Bob:

```json
{
  "error": "book is not available",
  "acknowledgedBy": "leader"
}
```

After the 10-second delay, read the catalog again:

```sh
curl http://localhost:3001/books/book-001
```

It now reports `status: checked_out`.

## What this demonstrates

```text
replica says available
    -> user attempts checkout
    -> primary says book is already checked out
    -> replica eventually catches up
```

The stale read creates a bad expectation, but the primary protects the invariant. The application must not use the replica to authorize a checkout.

The write response is authoritative. If Alice retries with the same key, the primary returns her original checkout:

```sh
curl -X POST http://localhost:3001/checkouts \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: alice-book-001' \
  -d '{"personId":"person-001","bookId":"book-001"}'
```

## Clean up

```sh
docker compose down -v
```
