import { createGameServer } from './app.js';
export { createGameServer } from './app.js';
const app = createGameServer();
const address = await app.listen();
console.log(`Kannon FPS server listening on http://${address.host}:${address.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
