// Prueba de carga del modo servidor.
// Levanta server.js en un puerto aparte, simula N participantes (cada uno con su propia
// conexión) y juega rondas completas como un grupo real.
//
//   node scripts/prueba-carga.js --n 25,50,100 --rondas 10 --spread 3000
//
// --spread: ventana (ms) en la que los participantes presionan tras iniciar la ronda.
//           0 = todos al mismo tiempo (peor caso).
import { fork, spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { io } from 'socket.io-client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const SIZES = (args.n ?? '25,50,100,200').split(',').map(Number);
const ROUNDS = Number(args.rondas ?? 10);
const SPREAD = Number(args.spread ?? 3000);
const WORKERS = Number(args.workers ?? Math.max(2, Math.min(4, availableParallelism() - 2)));
const PORT = Number(args.port ?? 3100);
const OUT = args.out;
const APP_TIMEOUT_MS = 8000; // la app muestra error si el servidor no responde en 8 s

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r0 = (v) => (v === null || v === undefined ? '—' : Math.round(v));

async function startServer() {
  const child = spawn(process.execPath, [args.server ?? 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    child.stdout.on('data', (d) => { if (String(d).includes('corriendo')) res(); });
    child.on('exit', (c) => rej(new Error(`el servidor terminó (${c})`)));
  });
  return child;
}

function sampleServer(pid) {
  const samples = [];
  const timer = setInterval(() => {
    execFile('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], (err, out) => {
      if (err) return;
      const [cpu, rss] = out.trim().split(/\s+/).map(Number);
      samples.push({ cpu, rssMB: rss / 1024 });
    });
  }, 500);
  return { stop: () => { clearInterval(timer); return samples; } };
}

function emitAck(socket, event, data) {
  return new Promise((resolve, reject) => {
    socket.timeout(60000).emit(event, data, (err, resp) => (err ? reject(new Error(`${event}: sin respuesta`)) : resp.ok ? resolve(resp) : reject(new Error(resp.error))));
  });
}

function onceMsg(worker, type) {
  return new Promise((resolve, reject) => {
    const h = (m) => {
      if (m.type === type) { worker.off('message', h); resolve(m); }
      else if (m.type === 'error') { worker.off('message', h); reject(new Error(m.error)); }
    };
    worker.on('message', h);
  });
}

async function runScenario(N, serverPid) {
  const url = `http://localhost:${PORT}`;
  const host = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((r) => host.once('connect', r));
  const { code } = await emitAck(host, 'host:create', {});

  const names = Array.from({ length: N }, (_, i) => `P${String(i + 1).padStart(4, '0')}`);
  const k = Math.min(WORKERS, N);
  const workers = Array.from({ length: k }, () => fork(join(ROOT, 'scripts', 'carga-worker.js')));
  const slices = workers.map((_, w) => names.filter((_, i) => i % k === w));

  const sampler = sampleServer(serverPid);
  const tJoin = now();
  await Promise.all(workers.map((w, i) => {
    const p = onceMsg(w, 'joined');
    w.send({ cmd: 'join', url, code, names: slices[i], spread: SPREAD, totalPlayers: N });
    return p;
  }));
  const joinMs = now() - tJoin;

  const roundInfo = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const t = now();
    await emitAck(host, 'action', { action: 'start', payload: { question: `Ronda ${r}` } });
    const done = await Promise.all(workers.map((w) => {
      const p = onceMsg(w, 'roundDone');
      w.send({ cmd: 'waitRound', round: r, timeoutMs: SPREAD + 60000 });
      return p;
    }));
    await emitAck(host, 'action', { action: 'close' });
    roundInfo.push({ round: r, ms: now() - t, timedOut: done.some((d) => d.timedOut) });
    process.stdout.write(`   ronda ${r}/${ROUNDS} ${Math.round(now() - t)} ms${done.some((d) => d.timedOut) ? ' (incompleta)' : ''}\r`);
    await sleep(300);
  }
  process.stdout.write('\n');
  await sleep(300);
  const serverSamples = sampler.stop();

  const { result: finalRounds } = await emitAck(host, 'action', { action: 'export' });
  const reports = await Promise.all(workers.map((w) => { const p = onceMsg(w, 'report'); w.send({ cmd: 'report' }); return p; }));
  workers.forEach((w) => w.send({ cmd: 'exit' }));
  host.disconnect();

  // ---- Análisis
  const presses = reports.flatMap((r) => r.presses);
  const sentBy = new Map(presses.map((p) => [`${p.round}|${p.name}`, p.sent]));
  const ack = presses.filter((p) => p.acked !== null && !p.error).map((p) => p.acked - p.sent);
  const errors = presses.filter((p) => p.error).length;
  const overAppTimeout = ack.filter((v) => v > APP_TIMEOUT_MS).length;

  // Aviso al grupo: desde que alguien presiona hasta que lo recibe el último participante.
  const merged = {};
  for (const r of reports) {
    for (const [key, [mn, mx, c]] of Object.entries(r.notifyRecv)) {
      const m = merged[key];
      if (m) { m[0] = Math.min(m[0], mn); m[1] = Math.max(m[1], mx); m[2] += c; } else merged[key] = [mn, mx, c];
    }
  }
  const fanLast = [];
  let incompleteDelivery = 0;
  for (const [key, [, mx, c]] of Object.entries(merged)) {
    const sent = sentBy.get(key);
    if (sent !== undefined) fanLast.push(mx - sent);
    if (c < N) incompleteDelivery += 1;
  }

  // Precisión: diferencia entre la hora real en que presionó y la hora que registró el servidor,
  // y errores de orden (alguien que presionó antes quedó registrado después).
  const recordDelay = [];
  let inversions = 0;
  let maxOvertakeMs = 0;
  let wrongFirst = 0;
  for (const round of finalRounds ?? []) {
    const list = round.presses.map((p) => ({ ...p, sent: sentBy.get(`${round.number}|${p.name}`) })).filter((p) => p.sent !== undefined);
    for (const p of list) recordDelay.push(p.at - p.sent);
    const bySent = [...list].sort((a, b) => a.sent - b.sent);
    if (bySent[0] && bySent[0].position !== 1) wrongFirst += 1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const b = list[j]; // a quedó antes que b en el registro
        if (b.sent < a.sent) { inversions += 1; maxOvertakeMs = Math.max(maxOvertakeMs, a.sent - b.sent); }
      }
    }
  }

  const sample = reports.reduce((a, r) => (r.stateSample.total > a.total ? r.stateSample : a), { total: 0, max: 0, count: 0 });
  const cpu = serverSamples.map((s) => s.cpu);
  const rss = serverSamples.map((s) => s.rssMB);
  return {
    N,
    joinMs,
    roundMsAvg: roundInfo.reduce((a, r) => a + r.ms, 0) / roundInfo.length,
    roundsIncomplete: roundInfo.filter((r) => r.timedOut).length,
    presses: presses.length,
    errors,
    overAppTimeout,
    ack: { p50: pct(ack, 50), p95: pct(ack, 95), max: pct(ack, 100) },
    fanLast: { p50: pct(fanLast, 50), p95: pct(fanLast, 95), max: pct(fanLast, 100) },
    incompleteDelivery,
    recordDelay: { p50: pct(recordDelay, 50), p95: pct(recordDelay, 95), max: pct(recordDelay, 100) },
    inversions,
    maxOvertakeMs,
    wrongFirst,
    statesPerPlayer: sample.count,
    stateMaxKB: sample.max / 1024,
    perPlayerMB: sample.total / 1024 / 1024, // datos de estado que recibe cada participante en todo el juego
    totalMB: (sample.total * N) / 1024 / 1024,
    serverCpu: { avg: cpu.reduce((a, b) => a + b, 0) / (cpu.length || 1), max: Math.max(...cpu) },
    serverRssMB: Math.max(...rss),
    disconnects: reports.reduce((acc, r) => { for (const [k, v] of Object.entries(r.disconnects)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
    workerLagMax: Math.max(...reports.map((r) => r.lag.p99)),
  };
}

const server = await startServer();
console.log(`Prueba de carga · ${ROUNDS} rondas · ventana para presionar ${SPREAD} ms · ${WORKERS} procesos simulando participantes\n`);
const results = [];
try {
  for (const N of SIZES) {
    console.log(`▶ ${N} participantes`);
    const r = await runScenario(N, server.pid);
    results.push(r);
    console.log(`   respuesta al presionar p50 ${r0(r.ack.p50)} ms · p95 ${r0(r.ack.p95)} ms · máx ${r0(r.ack.max)} ms`);
    console.log(`   aviso al último del grupo p50 ${r0(r.fanLast.p50)} ms · p95 ${r0(r.fanLast.p95)} ms · máx ${r0(r.fanLast.max)} ms`);
    console.log(`   retraso al registrar p95 ${r0(r.recordDelay.p95)} ms · máx ${r0(r.recordDelay.max)} ms · orden invertido ${r.inversions} pares (hasta ${r0(r.maxOvertakeMs)} ms) · 1.º mal ${r.wrongFirst}/${ROUNDS}`);
    console.log(`   estados recibidos por participante ${r.statesPerPlayer} (máx ${r.stateMaxKB.toFixed(0)} KB) · datos por participante ${r.perPlayerMB.toFixed(1)} MB · total ${r.totalMB.toFixed(0)} MB · CPU servidor prom ${r0(r.serverCpu.avg)}% máx ${r0(r.serverCpu.max)}% · RAM ${r0(r.serverRssMB)} MB`);
    console.log(`   errores ${r.errors} · >8 s ${r.overAppTimeout} · rondas incompletas ${r.roundsIncomplete} · avisos incompletos ${r.incompleteDelivery} · lag simulador p99 ${r0(r.workerLagMax)} ms · desconexiones ${JSON.stringify(r.disconnects)}\n`);
    if (r.overAppTimeout > 0 || r.roundsIncomplete > 0) {
      console.log(`■ Límite alcanzado con ${N} participantes; no se prueban tamaños mayores.`);
      break;
    }
    await sleep(1500);
  }
} finally {
  server.kill();
  if (OUT) writeFileSync(OUT, JSON.stringify({ rounds: ROUNDS, spread: SPREAD, results }, null, 2));
}
