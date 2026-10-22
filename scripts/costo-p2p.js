// Estima el trabajo del navegador del moderador en modo P2P (GitHub Pages).
// En P2P el moderador hace de servidor: por cada presión manda el aviso a todos y, de forma
// agrupada, el estado. Aquí se mide con el mismo código del juego (game.js, room.js) en Node.js.
// No incluye el costo de WebRTC ni el de dibujar la pantalla: en un navegador real es mayor.
//
//   node scripts/costo-p2p.js --n 25,50,100,200 --spread 3000
import { Game } from '../public/js/game.js';
import { applyAction, StateFeed } from '../public/js/room.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SIZES = arg('n', '25,50,100,200,300,500').split(',').map(Number);
const ROUNDS = 10;
const SPREAD_MS = Number(arg('spread', 3000));

// Reloj simulado para que el agrupado de envíos se comporte como en una ronda real.
function fakeClock() {
  let t = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    advanceTo(target) {
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = target;
    },
  };
}

console.log(`Costo del moderador en modo P2P · ${ROUNDS} rondas · todos presionan en ~${SPREAD_MS / 1000} s\n`);
console.log('Participantes | CPU en la ronda 10 | carga en la ventana | subida en la ronda 10 | subida en todo el juego');
for (const n of SIZES) {
  const clock = fakeClock();
  const game = new Game({ now: clock.now });
  let cpuMs = 0;
  let bytes = 0;
  let measuring = false;
  const feed = new StateFeed(game, (hostMsg, playerMsg) => {
    const t = performance.now();
    let b = 0;
    for (let i = 0; i < n; i++) b += JSON.stringify({ type: 'state', state: playerMsg }).length;
    JSON.stringify(hostMsg);
    JSON.stringify(game.toJSON()); // copia guardada en el navegador del moderador
    cpuMs += measuring ? performance.now() - t : 0;
    bytes += b;
  }, clock);
  const run = (who, action, payload) => {
    const out = applyAction(game, who, action, payload);
    if (out.notify?.kind === 'press') feed.event(out.notify); // viaja agrupado con el estado
    else if (out.notify) {
      const t = performance.now();
      let b = 0;
      for (let i = 0; i < n; i++) b += JSON.stringify({ type: 'notify', notify: out.notify }).length;
      cpuMs += measuring ? performance.now() - t : 0;
      bytes += b;
    }
    feed.changed(out.parts, { urgent: out.urgent, patch: out.patch });
  };
  for (let i = 0; i < n; i++) run({ clientId: `p${i}` }, 'join', { name: `Participante ${i + 1}` });
  let roundBytes = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    measuring = r === ROUNDS;
    const startBytes = bytes;
    run({ isHost: true }, 'start', { question: `Pregunta número ${r} de la actividad` });
    const start = clock.now();
    const times = Array.from({ length: n }, () => Math.random() * SPREAD_MS).sort((a, b) => a - b);
    times.forEach((dt, i) => { clock.advanceTo(start + dt); run({ clientId: `p${i}` }, 'press', { answer: 'Respuesta de ejemplo' }); });
    clock.advanceTo(start + SPREAD_MS + 1000);
    run({ isHost: true }, 'close');
    // El moderador valida una respuesta cada ~0.8 s.
    for (let i = 0; i < n; i++) { clock.advanceTo(clock.now() + 800); run({ isHost: true }, 'validate', { round: r, playerId: `p${i}`, valid: i % 3 !== 0 }); }
    clock.advanceTo(clock.now() + 1000);
    roundBytes = bytes - startBytes;
  }
  const mb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);
  console.log(
    `${String(n).padStart(13)} | ${(cpuMs / 1000).toFixed(2).padStart(16)} s | ${((cpuMs / SPREAD_MS) * 100).toFixed(0).padStart(18)}% | ${mb(roundBytes).padStart(21)} | ${mb(bytes).padStart(23)}`,
  );
}
console.log('\nIncluye validar todas las respuestas, una cada 0.8 s.');
console.log('Carga > 100%: el moderador no alcanza a enviar al ritmo en que llegan las presiones.');
