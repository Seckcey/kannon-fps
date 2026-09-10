import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { MatchEngine, sanitizeInput } from './engine.js';
import { PRACTICE_RIVALS } from './bots.js';
import { GameStore } from './store.js';
import { hasMatchOpponents, RULES, WORLD_VERSION, type AvailableGame, type ClientMessage, type GameEvent, type PracticeDifficulty, type Profile, type RoomSnapshot, type RoomVisibility, type ServerMessage } from '../shared/protocol.js';

export interface ServerOptions { port?: number; host?: string; dbPath?: string; staticDir?: string; allowedOrigins?: string[] }
interface Connection { socket: WebSocket; profile: Profile | null; roomId: string | null; connectedAt: number; bucketAt: number; messages: number; controlAt: number; controls: number; alive: boolean; supportsReadiness: boolean }
interface Room { id: string; code: string; hostId: string; ranked: boolean; practice: boolean; practiceDifficulty?: PracticeDifficulty; visibility: RoomVisibility; fillBots: boolean; botDifficulty?: PracticeDifficulty; crewId?: string; expiresAt: number; engine: MatchEngine; sockets: Map<string, Connection>; disconnected: Map<string, number>; abandoned: boolean; phase: string; emptySince: number; resultEvent: Extract<GameEvent, { type: 'match-end' }> | null; preparation?: { id: string; expiresAt: number; ready: Set<string> } }
class HttpError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
class ProtocolError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
const ROOM_LIFETIME = 2 * 60 * 60 * 1000;
const DISCONNECT_GRACE = 30_000;
const PREPARATION_TIMEOUT = 45_000;
const GAME_UPDATE_MESSAGE = 'A player is using an older game page. Everyone should refresh the page before starting.';
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };

export function createGameServer(options: ServerOptions = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 3001);
  const store = new GameStore(options.dbPath ?? process.env.DB_PATH ?? resolve(process.env.DATA_DIR ?? 'data', 'kannon.sqlite'));
  const staticDir = resolve(options.staticDir ?? 'dist');
  const allowedOrigins = new Set(options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map((v) => v.trim()).filter(Boolean));
  const rooms = new Map<string, Room>(); const codes = new Map<string, string>();
  const connections = new Set<Connection>(); const playersOnline = new Map<string, Connection>();
  const rateBuckets = new Map<string, { count: number; since: number }>();
  let closed = false;
  function originAllowed(req: IncomingMessage, required = false) {
    const origin = req.headers.origin;
    if (!origin) return !required;
    if (allowedOrigins.has(origin)) return true;
    try { const url = new URL(origin); return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === req.headers.host; } catch { return false; }
  }
  function json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data));
  }
  function limit(req: IncomingMessage, key: string, max: number, window = 60_000) {
    // Deliberately ignore untrusted forwarding headers. Trusted reverse proxies should rate-limit too.
    const id = `${req.socket.remoteAddress}:${key}`; const now = Date.now();
    let bucket = rateBuckets.get(id);
    if (!bucket || now - bucket.since >= window) { bucket = { count: 0, since: now }; rateBuckets.set(id, bucket); }
    if (++bucket.count > max) throw new HttpError(429, 'A few too many requests. Please try again shortly.');
  }
  function auth(req: IncomingMessage): Profile {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const profile = store.authenticate(token); if (!profile) throw new HttpError(401, 'Sign in with your player key to continue.'); return profile;
  }
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send JSON content.');
    if (Number(req.headers['content-length'] ?? 0) > 8192) throw new HttpError(413, 'This request is too large.');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 8192) throw new HttpError(413, 'This request is too large.'); chunks.push(Buffer.from(chunk)); }
    try { const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result as Record<string, unknown>; }
    catch { throw new HttpError(400, 'Send a valid JSON object.'); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    // The bundled Meshopt decoder compiles WebAssembly for compressed art.
    // This does not permit JavaScript eval or scripts from external origins.
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'");
    try {
      if (!req.url || req.url.length > 2048) throw new HttpError(400, 'Invalid request.');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { status: 'ok', game: 'kannon-fps', version: '0.1.0', worldVersion: WORLD_VERSION, revision: process.env.GAME_BUILD_SHA || 'development' }); return; }
      if (url.pathname.startsWith('/api/')) {
        limit(req, url.pathname === '/api/games' ? 'games' : 'api', 180);
        if (!originAllowed(req)) throw new HttpError(403, 'This origin is not allowed.');
        if (req.method === 'GET' && url.pathname === '/api/games') {
          const now = Date.now();
          const games = [...rooms.values()].flatMap(room => { const game = availableGame(room, now); return game ? [game] : []; });
          json(res, 200, { games }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/profile') {
          limit(req, 'profile', 20); const input = await body(req);
          const result = store.saveProfile(input.name, input.token);
          // Updating the name also updates the current lobby display.
          const active = playersOnline.get(result.profile.id);
          if (active) { active.profile = result.profile; const room = active.roomId ? rooms.get(active.roomId) : null; const p = room?.engine.players.get(result.profile.id); if (p) { p.name = result.profile.name; broadcastRoom(room!); } }
          json(res, 200, result); return;
        }
        const profile = auth(req);
        if (req.method === 'GET' && url.pathname === '/api/profile') { json(res, 200, { profile }); return; }
        if (req.method === 'GET' && url.pathname === '/api/crews') { json(res, 200, { crews: store.listCrews(profile.id) }); return; }
        if (req.method === 'POST' && url.pathname === '/api/crews') { limit(req, 'crew-write', 20); const input = await body(req); json(res, 201, { crew: store.createCrew(profile.id, input.name) }); return; }
        if (req.method === 'POST' && url.pathname === '/api/crews/join') { limit(req, 'crew-write', 20); const input = await body(req); json(res, 200, { crew: store.joinCrew(profile.id, input.invite) }); return; }
        if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
          const crewId = url.searchParams.get('crewId'); const period = url.searchParams.get('period') ?? 'all';
          if (!crewId || (period !== 'all' && period !== 'month')) throw new HttpError(400, 'Choose a friend group and a valid leaderboard period.');
          if (!store.isMember(profile.id, crewId)) throw new HttpError(403, 'Join this friend group to view its leaderboard.');
          json(res, 200, store.leaderboard(profile.id, crewId, period)); return;
        }
        throw new HttpError(404, 'This API route was not found.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Invalid path.'); }
      if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(400, 'Invalid path.');
      if (pathname.split('/').some((part) => part.startsWith('.'))) throw new HttpError(404, 'File not found.');
      let file = resolve(staticDir, '.' + pathname);
      if (file !== staticDir && !file.startsWith(staticDir + sep)) throw new HttpError(403, 'Invalid path.');
      if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) {
        if (extname(pathname) || pathname.startsWith('/assets/')) throw new HttpError(404, 'File not found.');
        file = resolve(staticDir, 'index.html');
      }
      if (!existsSync(file)) throw new HttpError(404, 'The game client has not been built yet. Run npm run build.');
      const realRoot = realpathSync(staticDir); const realFile = realpathSync(file);
      if (!realFile.startsWith(realRoot + sep)) throw new HttpError(403, 'Invalid path.');
      // The texture transcoder worker is the one script allowed to build functions from source:
      // the Emscripten bindings need it. A worker loaded from its own URL carries its own policy,
      // so the page keeps the strict policy above. It can load nothing else and reach nowhere.
      if (pathname === '/basis/ktx2-worker.js') res.setHeader('content-security-policy', "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'");
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (req.method === 'HEAD') res.end(); else { const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); }
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else if (error instanceof Error && !error.message.includes('SQLITE')) json(res, 400, { error: error.message });
      else { console.error('Request failed', error instanceof Error ? error.message : 'unknown error'); json(res, 500, { error: 'The server could not complete this request.' }); }
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.url !== '/ws') throw new Error('Not found');
      if (!originAllowed(req, true)) throw new Error('Origin denied');
      limit(req, 'upgrade', 30); if (connections.size >= 256) throw new Error('Server full');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  function send(connection: Connection, message: ServerMessage) {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 256 * 1024) { connection.socket.close(1013, 'Connection is too slow'); return; }
    connection.socket.send(JSON.stringify(message));
  }
  function roomSnapshot(room: Room): RoomSnapshot {
    return { id: room.id, code: room.code, hostId: room.hostId, ranked: room.ranked, practice: room.practice, visibility: room.visibility, fillBots: room.fillBots, ...(room.fillBots ? { botDifficulty: room.botDifficulty } : {}), ...(room.practice ? { practiceDifficulty: room.practiceDifficulty } : {}), ...(room.crewId ? { crewId: room.crewId } : {}), phase: room.engine.phase, players: [...room.engine.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, ...(p.bot ? { bot: true } : {}), ...(room.preparation ? { ready: !!p.bot || (p.connected && room.preparation.ready.has(p.id)) } : {}) })), expiresAt: room.expiresAt, ...(room.preparation ? { preparation: { id: room.preparation.id, expiresAt: room.preparation.expiresAt } } : {}) };
  }
  function availableGame(room: Room, now: number): AvailableGame | null {
    if (room.visibility !== 'public' || room.ranked || room.practice || room.engine.phase !== 'waiting' || room.expiresAt <= now || !room.sockets.size) return null;
    const players = [...room.engine.players.values()], humanCount = players.filter(p => !p.bot).length;
    if (humanCount >= RULES.maxPlayers) return null;
    return { id: room.id, hostName: room.engine.players.get(room.hostId)!.name, humanCount, botCount: players.filter(p => p.bot).length, maxPlayers: RULES.maxPlayers, fillBots: room.fillBots, ...(room.fillBots ? { botDifficulty: room.botDifficulty } : {}) };
  }
  function syncLobbyBots(room: Room) {
    if (room.engine.phase !== 'waiting' && room.engine.phase !== 'finished') return;
    // Temporarily disconnected humans keep their seats until their grace expires.
    const humans = [...room.engine.players.values()].filter(p => !p.bot).length;
    const desired = room.practice ? 3 : room.fillBots ? Math.max(0, 4 - humans) : 0;
    const rivals = PRACTICE_RIVALS.slice(0, desired);
    for (const player of room.engine.players.values()) if (player.bot && !rivals.some(rival => rival.id === player.id)) room.engine.removePlayer(player.id);
    for (const rival of rivals) if (!room.engine.players.has(rival.id)) room.engine.addPlayer(rival, Date.now(), true);
  }
  function broadcast(room: Room, message: ServerMessage) { for (const connection of room.sockets.values()) send(connection, message); }
  function broadcastRoom(room: Room) { room.phase = room.engine.phase; broadcast(room, { type: 'room', room: roomSnapshot(room) }); }
  function electConnectedHost(room: Room) {
    if (!room.sockets.has(room.hostId) && room.sockets.size) room.hostId = room.sockets.keys().next().value!;
  }
  function cancelPreparation(room: Room, code: string, message: string) {
    if (!room.preparation) return;
    room.preparation = undefined; room.engine.cancelPreparation(); room.abandoned = false; syncLobbyBots(room);
    broadcastRoom(room); broadcast(room, { type: 'snapshot', snapshot: room.engine.snapshot() });
    // The client clears prior errors on room transitions, so the lobby's reason
    // must follow its final room state and survive the next unchanged tick.
    broadcast(room, { type: 'error', code, message });
  }
  function advancePreparation(room: Room, now: number) {
    const preparation = room.preparation;
    if (!preparation || room.engine.phase !== 'preparing') return;
    if (now >= preparation.expiresAt) {
      cancelPreparation(room, 'PREPARATION_TIMEOUT', 'Players were not ready in time. You are back in the lobby; the host can try again.'); return;
    }
    const humans = [...room.engine.players.values()].filter(p => !p.bot);
    if (humans.some(p => p.connected && !room.sockets.get(p.id)?.supportsReadiness)) {
      cancelPreparation(room, 'GAME_UPDATE_REQUIRED', GAME_UPDATE_MESSAGE); return;
    }
    if (humans.length < 1 || room.engine.players.size < 2) {
      cancelPreparation(room, 'PREPARATION_CANCELLED', 'A player left before the match was ready. You are back in the lobby; the host can try again.'); return;
    }
    // Reserve a temporarily disconnected participant's place until recovery or
    // grace expiry. Their old acknowledgment cannot start a round without them.
    if (!humans.every(p => p.connected && room.sockets.has(p.id) && preparation.ready.has(p.id))) return;
    room.engine.beginPreparedCountdown(now); room.preparation = undefined;
    broadcastRoom(room); broadcast(room, { type: 'snapshot', snapshot: room.engine.snapshot(now) });
  }
  function finishRoom(room: Room, reason: string) {
    let ranked = false; let finalReason = reason;
    const connectedHumans = [...room.engine.players.values()].filter((player) => !player.bot && player.connected).length;
    const completeRoster = !room.abandoned && room.disconnected.size === 0 && connectedHumans >= 2;
    if (room.ranked && !completeRoster) finalReason = `${reason} This incomplete match does not affect the leaderboard.`;
    if (room.ranked && !room.practice && !room.fillBots && ![...room.engine.players.values()].some(p => p.bot) && room.crewId && completeRoster && room.engine.startedAt) {
      try {
        const result = store.recordMatch({ id: room.engine.id, crewId: room.crewId, endedAt: room.engine.endedAt, duration: Math.floor((room.engine.endedAt - room.engine.startedAt) / 1000), winnerIds: room.engine.winnerIds, players: [...room.engine.players.values()].filter((p) => !p.bot).map((p) => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths })) });
        ranked = result.recorded; finalReason = `${reason} ${result.reason}`;
      } catch { finalReason = `${reason} The result could not be saved. Please contact the server owner.`; console.error('Could not persist match result', room.engine.id); }
    }
    room.resultEvent = { type: 'match-end', winnerIds: [...room.engine.winnerIds], ranked, reason: finalReason, at: room.engine.endedAt };
    broadcast(room, { type: 'event', event: room.resultEvent });
    broadcastRoom(room); broadcast(room, { type: 'snapshot', snapshot: room.engine.snapshot() });
  }
  function destroyRoom(room: Room) {
    for (const connection of room.sockets.values()) { connection.roomId = null; send(connection, { type: 'error', code: 'ROOM_EXPIRED', message: 'This room has expired. Create a new match.' }); }
    codes.delete(room.code); rooms.delete(room.id);
  }
  function leaveRoom(connection: Connection, disconnect = false) {
    const room = connection.roomId ? rooms.get(connection.roomId) : undefined; const id = connection.profile?.id;
    if (!room || !id) { connection.roomId = null; return; }
    if (room.sockets.get(id) !== connection) { connection.roomId = null; return; }
    room.sockets.delete(id); room.engine.setConnected(id, false); room.preparation?.ready.delete(id);
    if (disconnect) room.disconnected.set(id, Date.now());
    else {
      room.disconnected.delete(id);
      if (room.engine.phase === 'waiting' || room.engine.phase === 'preparing' || room.engine.phase === 'finished') room.engine.removePlayer(id);
      else { room.abandoned = true; room.disconnected.set(id, Date.now() - DISCONNECT_GRACE); }
    }
    connection.roomId = null;
    electConnectedHost(room);
    if (!room.sockets.size) room.emptySince = Date.now();
    if (!disconnect && (room.engine.phase === 'playing' || room.engine.phase === 'countdown') && !room.practice && !hasMatchOpponents(room.engine.players.values())) room.engine.finish('Match ended because a player left.', Date.now(), true);
    syncLobbyBots(room);
    broadcastRoom(room);
    if (room.preparation) advancePreparation(room, Date.now());
    if (!room.sockets.size && !disconnect) destroyRoom(room);
  }
  function attach(connection: Connection, room: Room) {
    const profile = connection.profile!;
    const existing = room.engine.players.get(profile.id);
    if (!existing && room.engine.players.size >= RULES.maxPlayers) throw new Error('This room is full.');
    if (!existing && room.engine.phase !== 'waiting') throw new Error('This match has started. Ask the host for a new room after the match.');
    if (room.practice && room.hostId !== profile.id) throw new Error('The practice range is a solo room. Create a friends match to play together.');
    if (room.ranked && (!room.crewId || !store.isMember(profile.id, room.crewId))) throw new Error('Join this friend group before entering its ranked match.');
    leaveRoom(connection);
    connection.roomId = room.id; room.sockets.set(profile.id, connection); room.disconnected.delete(profile.id); room.emptySince = 0; room.preparation?.ready.delete(profile.id);
    room.engine.addPlayer(profile); electConnectedHost(room); syncLobbyBots(room);
    if (room.preparation) {
      advancePreparation(room, Date.now());
      if (!room.preparation) return; // Cancellation already published the final lobby and reason.
    }
    broadcastRoom(room); send(connection, { type: 'snapshot', snapshot: room.engine.snapshot() });
    if (room.engine.phase === 'finished' && room.resultEvent) send(connection, { type: 'event', event: room.resultEvent });
  }
  wss.on('connection', (socket) => {
    const connection: Connection = { socket, profile: null, roomId: null, connectedAt: Date.now(), bucketAt: Date.now(), messages: 0, controlAt: Date.now(), controls: 0, alive: true, supportsReadiness: false }; connections.add(connection);
    socket.on('pong', () => { connection.alive = true; });
    socket.on('message', (data, binary) => {
      try {
        const now = Date.now();
        if (now - connection.bucketAt >= 1000) { connection.bucketAt = now; connection.messages = 0; }
        if (++connection.messages > 90 || binary) { socket.close(1008, 'Message limit exceeded'); return; }
        let message: ClientMessage;
        try { message = JSON.parse(data.toString()) as ClientMessage; } catch { throw new Error('Invalid message.'); }
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('Invalid message.');
        if (message.type === 'ping') { if (typeof message.t === 'number' && Number.isFinite(message.t)) send(connection, { type: 'pong', t: message.t }); return; }
        if (message.type === 'hello') {
          if (connection.profile) throw new Error('You are already signed in.');
          const profile = store.authenticate(message.token); if (!profile) { send(connection, { type: 'error', code: 'AUTH_REQUIRED', message: 'Your player key was not recognized.' }); socket.close(1008, 'Authentication required'); return; }
          const previous = playersOnline.get(profile.id);
          if (previous && previous !== connection) { leaveRoom(previous, true); previous.socket.close(4001, 'Player connected in another tab'); }
          connection.profile = profile; connection.supportsReadiness = message.readyProtocol === 1 && message.worldVersion === WORLD_VERSION; playersOnline.set(profile.id, connection); send(connection, { type: 'welcome', playerId: profile.id });
          // Restore a disconnected player's room automatically using the authenticated identity.
          const previousRoom = [...rooms.values()].find((room) => room.expiresAt > now && room.disconnected.has(profile.id) && now - room.disconnected.get(profile.id)! <= DISCONNECT_GRACE);
          if (previousRoom) attach(connection, previousRoom);
          return;
        }
        if (!connection.profile) throw new Error('Sign in before joining a match.');
        if (message.type === 'input') {
          const room = connection.roomId ? rooms.get(connection.roomId) : undefined; if (!room) return;
          if (!connection.supportsReadiness) throw new ProtocolError('GAME_UPDATE_REQUIRED', GAME_UPDATE_MESSAGE);
          const input = sanitizeInput(message.input); if (!input) throw new Error('Invalid player input.');
          room.engine.acceptInput(connection.profile.id, input, now); return;
        }
        if (now - connection.controlAt >= 10_000) { connection.controlAt = now; connection.controls = 0; }
        if (++connection.controls > 24) throw new Error('Slow down a little before changing rooms again.');
        if (message.type === 'create') {
          if (typeof message.ranked !== 'boolean' || (message.practice !== undefined && typeof message.practice !== 'boolean') || (message.crewId !== undefined && (typeof message.crewId !== 'string' || message.crewId.length > 100))) throw new Error('Invalid match settings.');
          if (message.practiceDifficulty !== undefined && !['easy', 'normal', 'hard'].includes(message.practiceDifficulty)) throw new Error('Choose a valid practice difficulty.');
          if (message.visibility !== undefined && !['private', 'public'].includes(message.visibility)) throw new Error('Choose Public or Private for your match.');
          if (message.fillBots !== undefined && typeof message.fillBots !== 'boolean') throw new Error('Choose whether to fill the room with bots.');
          if (message.botDifficulty !== undefined && !['easy', 'normal', 'hard'].includes(message.botDifficulty)) throw new Error('Choose a valid bot difficulty.');
          if (rooms.size >= 64) throw new Error('The server is busy. Please try again shortly.');
          const practice = message.practice ?? false; const ranked = message.ranked && !practice;
          const practiceDifficulty = practice ? message.practiceDifficulty ?? 'normal' : undefined;
          const visibility = message.visibility ?? 'private';
          const fillBots = !practice && (message.fillBots ?? false);
          const botDifficulty = fillBots ? message.botDifficulty ?? 'normal' : undefined;
          if (practice && visibility === 'public') throw new Error('Solo bot matches are private. Create a public casual match to play together.');
          if (ranked && (visibility === 'public' || fillBots)) throw new Error('Ranked crew matches must be private and have human players only.');
          if (ranked && (!message.crewId || !store.isMember(connection.profile.id, message.crewId))) throw new Error('Choose one of your friend groups for a ranked match.');
          leaveRoom(connection);
          const id = randomUUID(); let code = '';
          do { code = randomBytes(10).toString('hex').toUpperCase(); } while (codes.has(code));
          const room: Room = { id, code, hostId: connection.profile.id, ranked, practice, visibility, fillBots, ...(fillBots ? { botDifficulty } : {}), ...(practice ? { practiceDifficulty } : {}), ...(message.crewId && ranked ? { crewId: message.crewId } : {}), expiresAt: now + ROOM_LIFETIME, engine: null as unknown as MatchEngine, sockets: new Map(), disconnected: new Map(), abandoned: false, phase: 'waiting', emptySince: 0, resultEvent: null };
          room.engine = new MatchEngine({ practice, practiceDifficulty, fillBots, botDifficulty, onEvent: (event) => broadcast(room, { type: 'event', event }), onFinish: (reason) => finishRoom(room, reason) });
          rooms.set(id, room); codes.set(code, id); attach(connection, room);
          return;
        }
        if (message.type === 'join-public') {
          if (typeof message.roomId !== 'string' || message.roomId.length > 100) throw new Error('Choose a game from Available Games.');
          const room = rooms.get(message.roomId);
          if (!room || !availableGame(room, now)) throw new ProtocolError('PUBLIC_GAME_UNAVAILABLE', 'This game is full or no longer available. Refresh Available Games and choose another.');
          if (connection.roomId === room.id) { send(connection, { type: 'room', room: roomSnapshot(room) }); return; }
          attach(connection, room); return;
        }
        if (message.type === 'join') {
          if (typeof message.code !== 'string' || message.code.length > 32) throw new Error('Enter a valid room code.');
          const roomId = codes.get(message.code.trim().toUpperCase()); const room = roomId ? rooms.get(roomId) : undefined;
          if (!room || room.expiresAt <= now) throw new ProtocolError('ROOM_NOT_FOUND', 'This room was not found or has expired.');
          if (connection.roomId === room.id) { send(connection, { type: 'room', room: roomSnapshot(room) }); return; }
          attach(connection, room); return;
        }
        if (message.type === 'leave') { leaveRoom(connection); return; }
        const room = connection.roomId ? rooms.get(connection.roomId) : undefined;
        if (!room) throw new Error('Join a room first.');
        if (message.type === 'ready') {
          if (typeof message.preparationId !== 'string' || message.preparationId.length > 100 || typeof message.ready !== 'boolean') throw new Error('Invalid readiness message.');
          if (!room.preparation || room.engine.phase !== 'preparing' || message.preparationId !== room.preparation.id) throw new ProtocolError('PREPARATION_STALE', 'This readiness request is no longer active.');
          if (room.sockets.get(connection.profile.id) !== connection || !room.engine.players.get(connection.profile.id)?.connected) throw new Error('Reconnect before marking yourself ready.');
          const wasReady = room.preparation.ready.has(connection.profile.id);
          if (message.ready) room.preparation.ready.add(connection.profile.id); else room.preparation.ready.delete(connection.profile.id);
          advancePreparation(room, now);
          if (room.preparation && wasReady !== message.ready) broadcastRoom(room);
          return;
        }
        if (message.type === 'start' || message.type === 'rematch') {
          if (room.hostId !== connection.profile.id) throw new Error('Only the room host can start a match.');
          if (message.type === 'rematch' && room.engine.phase !== 'finished') throw new Error('Finish this match before starting a rematch.');
          if (room.engine.phase !== 'waiting' && room.engine.phase !== 'finished') throw new Error('This match has already started.');
          if (!hasMatchOpponents(room.engine.players.values()) && !(room.fillBots && [...room.engine.players.values()].some(p => !p.bot && p.connected))) throw new Error('You need another player or an AI rival before starting.');
          if ([...room.engine.players.values()].some(p => !p.bot && p.connected && !room.sockets.get(p.id)?.supportsReadiness)) throw new ProtocolError('GAME_UPDATE_REQUIRED', GAME_UPDATE_MESSAGE);
          for (const [id, player] of room.engine.players) if (!player.connected) { room.engine.removePlayer(id); room.disconnected.delete(id); }
          syncLobbyBots(room);
          room.engine.prepare(now);
          room.abandoned = false; room.resultEvent = null;
          room.preparation = { id: room.engine.id, expiresAt: now + PREPARATION_TIMEOUT, ready: new Set() };
          broadcastRoom(room); broadcast(room, { type: 'snapshot', snapshot: room.engine.snapshot(now) }); return;
        }
        throw new Error('Unknown game message.');
      } catch (error) { send(connection, { type: 'error', message: error instanceof Error ? error.message : 'The server could not complete that action.', ...(error instanceof ProtocolError ? { code: error.code } : {}) }); }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      leaveRoom(connection, true); connections.delete(connection);
      if (connection.profile && playersOnline.get(connection.profile.id) === connection) playersOnline.delete(connection.profile.id);
    });
  });
  let lastStep = Date.now(); let snapshotTick = 0;
  const tickTimer = setInterval(() => {
    const now = Date.now(); const dt = Math.min(0.1, Math.max(0, (now - lastStep) / 1000)); lastStep = now;
    for (const room of rooms.values()) {
      if (room.expiresAt <= now || (room.emptySince && now - room.emptySince > DISCONNECT_GRACE)) { destroyRoom(room); continue; }
      for (const [id, since] of room.disconnected) {
        if (now - since <= DISCONNECT_GRACE) continue;
        room.disconnected.delete(id);
        if (room.engine.phase === 'waiting' || room.engine.phase === 'preparing' || room.engine.phase === 'finished') { room.engine.removePlayer(id); electConnectedHost(room); syncLobbyBots(room); broadcastRoom(room); }
        else if (!room.practice) {
          room.abandoned = true;
          if (!hasMatchOpponents(room.engine.players.values())) room.engine.finish('Match ended because a player disconnected.', now, true);
        }
      }
      if (room.preparation) advancePreparation(room, now);
      room.engine.step(now, dt);
      if (room.phase !== room.engine.phase) { room.phase = room.engine.phase; broadcastRoom(room); }
      if (snapshotTick % 2 === 0 && room.sockets.size) broadcast(room, { type: 'snapshot', snapshot: room.engine.snapshot(now) });
    }
    snapshotTick++;
  }, 1000 / 30);
  const housekeeping = setInterval(() => {
    const now = Date.now();
    for (const connection of connections) {
      if (!connection.profile && now - connection.connectedAt > 10_000) { connection.socket.close(1008, 'Authentication timeout'); continue; }
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false; connection.socket.ping();
    }
    for (const [key, bucket] of rateBuckets) if (now - bucket.since > 120_000) rateBuckets.delete(key);
  }, 15_000);
  tickTimer.unref(); housekeeping.unref();
  return {
    server, wss, store,
    listen: () => new Promise<{ port: number; host: string }>((resolveListen, reject) => {
      server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); const address = server.address(); if (!address || typeof address === 'string') reject(new Error('No TCP address')); else resolveListen({ port: address.port, host: address.address }); });
    }),
    close: async () => {
      if (closed) return; closed = true; clearInterval(tickTimer); clearInterval(housekeeping);
      for (const connection of connections) connection.socket.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => { if (server.listening) { server.close(() => done()); server.closeAllConnections(); } else done(); });
      store.close();
    },
  };
}
