const { createClient } = require('redis');

const delaySeconds = Number(process.env.REPLICATION_DELAY_SECONDS || 120);
const leader = createClient({ url: process.env.LEADER_URL || 'redis://localhost:6379' });
const replica = createClient({ url: process.env.REPLICA_URL || 'redis://localhost:6380' });

for (const client of [leader, replica]) {
  client.on('error', (error) => console.error('Redis client error:', error.message));
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  await Promise.all([leader.connect(), replica.connect()]);
  console.log(`Replicator started with a ${delaySeconds}s delay`);

  while (true) {
    const result = await leader.brPop('replication:queue', 0);
    const event = JSON.parse(result.element);
    console.log(`Queued checkout ${event.id}; waiting ${delaySeconds}s`);
    await wait(delaySeconds * 1000);

    const values = await Promise.all(event.keys.map((key) => leader.get(key)));
    const batch = replica.multi();
    event.keys.forEach((key, index) => {
      if (values[index] !== null) batch.set(key, values[index]);
    });
    await batch.exec();
    console.log(`Replicated checkout ${event.id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
