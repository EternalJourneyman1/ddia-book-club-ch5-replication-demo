# Replicated Library Checkout Demo

A small Docker Compose demo for DDIA Chapter 5. It models an online library with 20 people and 40 books:

```text
checkout writes -> primary database
catalog reads   -> delayed replica
```

The primary enforces the rule that a book can have only one active checkout. The catalog is intentionally read from the replica, so it can briefly show a book as available after another person has checked it out.

## Quick run

```sh
docker compose down -v
REPLICATION_DELAY_SECONDS=10 HOST_PORT=3001 docker compose up -d --build
./scripts/demo.sh
```

The script demonstrates:

1. Alice checks out `book-001`.
2. The replica still says `book-001` is available.
3. Bob tries to check out the same book.
4. The primary rejects Bob with `409 book is not available`.

After 10 seconds, the replica catches up:

```sh
curl http://localhost:3001/books/book-001
```

## Why this matters

The stale catalog is not authoritative for a checkout decision. A replica-only application must treat a checkout response from the write path as authoritative and must make retries idempotent. The demo uses an `Idempotency-Key` so a retry returns the original checkout instead of creating another one.

See [RUN.md](RUN.md) for the book-club walkthrough and expected responses. The initial people and books are in [data/seed.json](data/seed.json).

## Configuration

The default replication delay is two minutes. Use 10-30 seconds for a quick run:

```sh
REPLICATION_DELAY_SECONDS=15 HOST_PORT=3001 docker compose up -d --build
```

## Run natively in WSL

Docker is optional. Native WSL still needs Redis running twice: one instance for
the leader and one for the delayed replica. On Ubuntu WSL, install Redis once:

```sh
sudo apt-get update
sudo apt-get install -y redis-server
```

Start two local Redis instances:

```sh
mkdir -p /tmp/ddia-leader /tmp/ddia-replica
redis-server --port 6379 --dir /tmp/ddia-leader --daemonize yes --pidfile /tmp/ddia-leader.pid
redis-server --port 6380 --dir /tmp/ddia-replica --daemonize yes --pidfile /tmp/ddia-replica.pid
```

Install dependencies with the pinned local pnpm version:

```sh
corepack pnpm install --frozen-lockfile
```

In terminal one, start the API:

```sh
PORT=3001 LEADER_URL=redis://localhost:6379 \
REPLICA_URL=redis://localhost:6380 REPLICATION_DELAY_SECONDS=10 \
node src/server.js
```

In terminal two, start the delayed replicator:

```sh
LEADER_URL=redis://localhost:6379 REPLICA_URL=redis://localhost:6380 \
REPLICATION_DELAY_SECONDS=10 node src/replicator.js
```

In terminal three, run the demo:

```sh
BASE_URL=http://localhost:3001 ./scripts/demo.sh
```

Stop the native Redis instances when finished:

```sh
redis-cli -p 6379 shutdown
redis-cli -p 6380 shutdown
```

## Clean up

```sh
docker compose down -v
```

This is an educational simulation of the application-visible effect of an Oracle read replica. It does not reproduce Oracle Data Guard or GoldenGate internals.

## If the Docker build cannot reach the package registry

The Docker image uses a committed npm lockfile and retries package downloads.
If the build still reports a registry or network timeout, verify that Docker can
reach the image registries before retrying:

```sh
docker pull node:22-alpine
docker pull redis:7.4-alpine
docker compose build --no-cache
```

On a corporate network, Docker Desktop may also need the organization's proxy or
certificate configuration. The failure occurs during dependency download, before
the replication demo itself starts.

If the build reports `unable to get local issuer certificate`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or a similar TLS error, install the organization's
root CA in Docker Desktop's Linux VM/build environment. WSL's trusted
certificates are not automatically available inside Docker builds.

Do not disable TLS verification with `npm config set strict-ssl false`. Instead,
ask the network administrator for the organization's PEM/CRT root certificate,
save it in the repository directory as `corporate-root-ca.crt` locally, and add
this temporary Dockerfile step before the dependency install:

```dockerfile
COPY corporate-root-ca.crt /usr/local/share/ca-certificates/corporate-root-ca.crt
RUN apk add --no-cache ca-certificates && update-ca-certificates
```

The certificate must not be committed. Add it to `.gitignore`, then rebuild:

```sh
echo corporate-root-ca.crt >> .gitignore
docker compose build --no-cache
```

If the organization provides an HTTPS proxy, configure that proxy in Docker
Desktop's Docker Engine/network settings as well as in WSL. The important test
is that this succeeds from the build environment:

```sh
docker run --rm node:22-alpine npm view redis@4.7.0 version
```

For local dependency installation, use the pinned pnpm version from
`package.json`. Pnpm is the developer-facing package manager; Docker uses npm
inside the image to avoid requiring Corepack to download pnpm during the build:

```sh
corepack pnpm install --frozen-lockfile
```
