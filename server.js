// Servidor Node.js: sirve la interfaz y sincroniza las salas en tiempo real con Socket.IO.
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { Game, GameError } from './public/js/game.js';
import { applyAction, randomCode } from './public/js/room.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // las salas inactivas se borran tras 12 h
// Orígenes permitidos (p. ej. tu GitHub Pages). Por defecto, cualquiera.
const CORS_ORIGIN = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : '*';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: CORS_ORIGIN } });

/** @type {Map<string, {code: string, game: Game, hostToken: string, touched: number}>} */
const rooms = new Map();

app.get('/api/health', (_req, res) => {
  res.set('Access-Control-Allow-Origin', Array.isArray(CORS_ORIGIN) ? CORS_ORIGIN[0] : '*');
  res.json({ ok: true, mode: 'server', rooms: rooms.size });
});
app.use(express.static(join(__dirname, 'public')));

const normalize = (code) => String(code ?? '').trim().toUpperCase();
const safeAck = (ack) => (typeof ack === 'function' ? ack : () => {});

function getRoom(code) {
  const room = rooms.get(normalize(code));
  if (room) room.touched = Date.now();
  return room;
}

function errorMessage(err) {
  if (err instanceof GameError) return err.message;
  console.error(err);
  return 'Error interno del servidor.';
}

function emitState(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(`${code}:host`).emit('state', room.game.snapshot({ includeAnswers: true }));
  io.to(`${code}:players`).emit('state', room.game.snapshot());
}

function leaveRooms(socket) {
  for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
}

function bindHost(socket, room) {
  leaveRooms(socket);
  socket.data = { code: room.code, clientId: 'host', isHost: true };
  socket.join(`${room.code}:host`);
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('host:create', (_data, ack) => {
    ack = safeAck(ack);
    let code;
    do code = randomCode(4); while (rooms.has(code));
    const room = { code, game: new Game(), hostToken: randomUUID(), touched: Date.now() };
    rooms.set(code, room);
    bindHost(socket, room);
    ack({ ok: true, code, hostToken: room.hostToken });
    emitState(code);
  });

  socket.on('host:resume', (data, ack) => {
    ack = safeAck(ack);
    const room = getRoom(data?.code);
    if (!room || room.hostToken !== data?.hostToken) {
      return ack({ ok: false, error: 'La sala ya no existe en el servidor. Crea una nueva.' });
    }
    bindHost(socket, room);
    ack({ ok: true, code: room.code });
    emitState(room.code);
  });

  socket.on('player:join', (data, ack) => {
    ack = safeAck(ack);
    const room = getRoom(data?.code);
    if (!room) return ack({ ok: false, error: `No existe la sala "${normalize(data?.code)}". Verifica el código.` });
    const clientId = String(data?.clientId || socket.id).slice(0, 80);
    try {
      const out = applyAction(room.game, { clientId, isHost: false }, 'join', { name: data?.name });
      leaveRooms(socket);
      socket.data = { code: room.code, clientId, isHost: false };
      socket.join(`${room.code}:players`);
      ack({ ok: true, result: out.result });
      emitState(room.code);
    } catch (err) {
      ack({ ok: false, error: errorMessage(err) });
    }
  });

  socket.on('action', (data, ack) => {
    ack = safeAck(ack);
    const { code, clientId, isHost } = socket.data ?? {};
    const room = code && getRoom(code);
    if (!room) return ack({ ok: false, error: 'No estás conectado a ninguna sala.' });
    if (data?.action === 'join') return ack({ ok: false, error: 'Acción no permitida.' });
    try {
      const out = applyAction(room.game, { clientId, isHost }, data?.action, data?.payload ?? {});
      ack({ ok: true, result: out.result });
      if (out.notify) io.to([`${code}:host`, `${code}:players`]).emit('notify', out.notify);
      emitState(code);
    } catch (err) {
      ack({ ok: false, error: errorMessage(err) });
    }
  });

  socket.on('disconnect', async () => {
    const { code, clientId, isHost } = socket.data ?? {};
    const room = code && rooms.get(code);
    if (!room || isHost) return;
    // Solo se marca desconectado si no tiene otra pestaña abierta con el mismo id.
    const others = await io.in(`${code}:players`).fetchSockets();
    if (!others.some((s) => s.data?.clientId === clientId)) {
      room.game.setConnected(clientId, false);
      emitState(code);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > ROOM_TTL_MS) rooms.delete(code);
}, 30 * 60 * 1000).unref();

httpServer.listen(PORT, () => {
  console.log(`\n✋ ¡Yo ya estoy! corriendo en http://localhost:${PORT}`);
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`   En tu red local: http://${net.address}:${PORT}`);
    }
  }
  console.log('');
});
