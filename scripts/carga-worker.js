// Proceso auxiliar de la prueba de carga: simula un grupo de participantes.
// Cada participante usa su propia conexión (forceNew), como un dispositivo real.
import { io } from 'socket.io-client';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const now = () => performance.timeOrigin + performance.now(); // reloj común a todos los procesos
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();

let clients = [];
let cfg = null;
let stateSample = { total: 0, max: 0, count: 0 }; // estados que recibe un participante de muestra
const presses = []; // { name, round, sent, acked, error }
const notifyRecv = {}; // "ronda|nombre" -> [primera, última] hora de recepción
let roundCounts = new Map(); // ronda -> avisos de "press" recibidos en total
const disconnects = {}; // motivo -> cantidad

function emitAck(socket, event, data, timeout = 30000) {
  return new Promise((resolve) => {
    socket.timeout(timeout).emit(event, data, (err, resp) => resolve(err ? { ok: false, error: 'timeout' } : resp));
  });
}

async function join({ url, code, names, spread, totalPlayers }) {
  cfg = { spread, totalPlayers };
  const t0 = now();
  clients = await Promise.all(names.map(async (name, i) => {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((res, rej) => { socket.once('connect', res); socket.once('connect_error', rej); });
    const c = { name, socket, pressedRounds: new Set() };
    socket.on('notify', (n) => onNotify(c, n));
    socket.on('state', (s) => { if (s.events) for (const n of s.events) onNotify(c, n); });
    socket.on('disconnect', (reason, details) => { if (c.leaving) return; const k = `${reason}: ${details?.description?.message ?? details?.message ?? details?.description ?? ''}`; disconnects[k] = (disconnects[k] ?? 0) + 1; });
    if (i === 0) {
      // Solo un participante por proceso mide el tamaño del estado (medirlo en todos cuesta CPU).
      socket.on('state', (s) => {
        const bytes = JSON.stringify(s).length;
        stateSample.total += bytes;
        stateSample.max = Math.max(stateSample.max, bytes);
        stateSample.count += 1;
      });
    }
    const r = await emitAck(socket, 'player:join', { code, clientId: `cid-${name}`, name });
    if (!r?.ok) throw new Error(`join ${name}: ${r?.error}`);
    return c;
  }));
  process.send({ type: 'joined', ms: now() - t0 });
}

function onNotify(c, n) {
  if (n.kind === 'start') {
    if (c.pressedRounds.has(n.round)) return;
    c.pressedRounds.add(n.round);
    const delay = Math.random() * cfg.spread;
    setTimeout(async () => {
      const rec = { name: c.name, round: n.round, sent: now(), acked: null, error: null };
      presses.push(rec);
      const r = await emitAck(c.socket, 'action', { action: 'press', payload: { answer: 'ok' } });
      rec.acked = now();
      if (!r?.ok) rec.error = r?.error ?? 'error';
    }, delay);
  } else if (n.kind === 'press') {
    const key = `${n.round}|${n.name}`;
    const t = now();
    const v = notifyRecv[key];
    if (v) { v[0] = Math.min(v[0], t); v[1] = Math.max(v[1], t); v[2] += 1; } else notifyRecv[key] = [t, t, 1];
    roundCounts.set(n.round, (roundCounts.get(n.round) ?? 0) + 1);
  }
}

function waitRound(round, timeoutMs) {
  // Termina cuando cada participante de este proceso recibió el aviso de todos los demás.
  const expected = clients.length * cfg.totalPlayers;
  const t0 = now();
  return new Promise((resolve) => {
    const check = () => {
      const got = roundCounts.get(round) ?? 0;
      const myAcks = presses.filter((p) => p.round === round && p.acked !== null).length;
      if ((got >= expected && myAcks >= clients.length) || now() - t0 > timeoutMs) {
        resolve({ got, expected, myAcks, timedOut: got < expected || myAcks < clients.length });
      } else setTimeout(check, 50);
    };
    check();
  });
}

process.on('message', async (m) => {
  try {
    if (m.cmd === 'join') await join(m);
    else if (m.cmd === 'waitRound') process.send({ type: 'roundDone', round: m.round, ...(await waitRound(m.round, m.timeoutMs)) });
    else if (m.cmd === 'report') {
      process.send({
        type: 'report',
        presses,
        notifyRecv,
        stateSample,
        disconnects,
        lag: { p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 },
      });
    } else if (m.cmd === 'exit') {
      for (const c of clients) { c.leaving = true; c.socket.disconnect(); }
      setTimeout(() => process.exit(0), 200);
    }
  } catch (err) {
    process.send({ type: 'error', error: String(err?.message ?? err) });
  }
});
