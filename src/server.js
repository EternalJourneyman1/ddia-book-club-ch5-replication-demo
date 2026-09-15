const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');

const port = Number(process.env.PORT || 3000);
const delaySeconds = Number(process.env.REPLICATION_DELAY_SECONDS || 120);
const leader = createClient({ url: process.env.LEADER_URL || 'redis://localhost:6379' });
const replica = createClient({ url: process.env.REPLICA_URL || 'redis://localhost:6380' });

for (const client of [leader, replica]) {
  client.on('error', (error) => console.error('Redis client error:', error.message));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function seedStore(client) {
  const seed = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));
  const alreadySeeded = await client.get('library:seeded');
  if (alreadySeeded) return;

  const batch = client.multi();
  for (const person of seed.people) batch.set(`person:${person.id}`, JSON.stringify(person));
  for (const book of seed.books) batch.set(`book:${book.id}`, JSON.stringify(book));
  batch.set('library:seeded', new Date().toISOString());
  await batch.exec();
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function handler(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const bookMatch = url.pathname.match(/^\/books\/([^/]+)$/);
  const checkoutMatch = url.pathname.match(/^\/checkouts\/([^/]+)$/);

  if (request.method === 'POST' && url.pathname === '/checkouts') {
    const body = await readBody(request);
    const { personId, bookId } = body;
    const idempotencyKey = request.headers['idempotency-key'];
    if (!personId || !bookId || !idempotencyKey) {
      return send(response, 400, { error: 'personId, bookId, and Idempotency-Key are required' });
    }

    const existingCheckoutId = await leader.get(`idempotency:${idempotencyKey}`);
    if (existingCheckoutId) {
      const existing = await leader.get(`checkout:${existingCheckoutId}`);
      return send(response, 200, { checkout: JSON.parse(existing), replay: true, acknowledgedBy: 'leader' });
    }

    const [person, book] = await Promise.all([
      leader.get(`person:${personId}`),
      leader.get(`book:${bookId}`),
    ]);
    if (!person || !book) return send(response, 404, { error: 'person or book not found' });

    const currentBook = JSON.parse(book);
    if (currentBook.status !== 'available') {
      return send(response, 409, {
        error: 'book is not available',
        book: currentBook,
        acknowledgedBy: 'leader',
      });
    }

    const checkout = {
      id: `checkout-${randomUUID()}`,
      personId,
      bookId,
      status: 'checked_out',
      checkedOutAt: new Date().toISOString(),
    };
    const updatedBook = { ...currentBook, status: 'checked_out' };
    await leader.multi()
      .set(`book:${bookId}`, JSON.stringify(updatedBook))
      .set(`checkout:${checkout.id}`, JSON.stringify(checkout))
      .set(`idempotency:${idempotencyKey}`, checkout.id)
      .lPush('replication:queue', JSON.stringify({
        id: checkout.id,
        keys: [`book:${bookId}`, `checkout:${checkout.id}`],
      }))
      .exec();

    return send(response, 202, {
      checkout,
      acknowledgedBy: 'leader',
      replicaVisibleAfter: `${delaySeconds} seconds (approximately)`,
    });
  }

  if (request.method === 'GET' && url.pathname === '/books') {
    const keys = await replica.keys('book:*');
    const books = await Promise.all(keys.sort().map(async (key) => JSON.parse(await replica.get(key))));
    return send(response, 200, { source: 'replica', books });
  }

  if (request.method === 'GET' && bookMatch) {
    const id = decodeURIComponent(bookMatch[1]);
    const raw = await replica.get(`book:${id}`);
    if (!raw) return send(response, 404, { error: 'book not found', source: 'replica' });
    return send(response, 200, { source: 'replica', book: JSON.parse(raw) });
  }

  if (request.method === 'GET' && checkoutMatch) {
    const id = decodeURIComponent(checkoutMatch[1]);
    const raw = await replica.get(`checkout:${id}`);
    if (!raw) return send(response, 404, { error: 'checkout not visible yet', source: 'replica' });
    return send(response, 200, { source: 'replica', checkout: JSON.parse(raw) });
  }

  if (request.method === 'GET' && request.url === '/health') {
    return send(response, 200, { ok: true, delaySeconds });
  }

  return send(response, 404, { error: 'not found' });
}

async function main() {
  await Promise.all([leader.connect(), replica.connect()]);
  await Promise.all([seedStore(leader), seedStore(replica)]);
  http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      console.error(error);
      send(response, 500, { error: 'internal server error' });
    });
  }).listen(port, () => console.log(`API listening on port ${port}; delay=${delaySeconds}s`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
