import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/js/game.js';
import { applyAction, StateFeed, mergeState } from '../public/js/room.js';

// Reloj y temporizadores falsos para controlar el agrupado.
function fakeClock() {
  let t = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, tm]) => tm.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
  };
}

function setup(n = 5) {
  const clock = fakeClock();
  const game = new Game({ now: clock.now });
  const sent = { host: [], players: [] };
  const feed = new StateFeed(game, (h, p) => { sent.host.push(h); sent.players.push(p); }, clock);
  const run = (who, action, payload) => {
    const out = applyAction(game, who, action, payload);
    feed.changed(out.parts, { urgent: out.urgent, patch: out.patch });
    return out;
  };
  for (let i = 0; i < n; i++) run({ clientId: `p${i}` }, 'join', { name: `Persona ${i}` });
  return { clock, game, feed, sent, run };
}

// Lo que vería la pantalla del participante después de aplicar todos los envíos.
function replay(messages, start = null) {
  let view = start;
  for (const m of messages) {
    const r = mergeState(view, m);
    assert.ok(!r.needSync, 'no debería necesitar sincronizar');
    view = r.view;
  }
  return view;
}

test('agrupa las presiones: muchos avisos, pocos estados', () => {
  const { clock, sent, run } = setup(40);
  run({ isHost: true }, 'start', {});
  const before = sent.players.length;
  for (let i = 0; i < 40; i++) { clock.advance(25); run({ clientId: `p${i}` }, 'press', {}); }
  clock.advance(1000);
  const states = sent.players.length - before;
  assert.ok(states <= 6, `se enviaron ${states} estados para 40 presiones`);
});

test('las diferencias reconstruyen el mismo estado que un envío completo', () => {
  const { clock, feed, sent, run } = setup(6);
  for (let r = 1; r <= 3; r++) {
    run({ isHost: true }, 'start', { question: `Q${r}` });
    for (let i = 0; i < 6; i++) { clock.advance(90); run({ clientId: `p${i}` }, 'press', { answer: `r${i}` }); }
    clock.advance(500);
    run({ isHost: true }, 'close');
    run({ isHost: true }, 'validate', { round: r, playerId: 'p1', valid: true });
  }
  clock.advance(5000); // deja salir lo que quedó agrupado (la clasificación tarda hasta 3 s)
  const view = replay([feed.full(false), ...sent.players]);
  const full = feed.full(false);
  for (const k of ['live', 'history', 'ranking', 'players', 'roundsPlayed']) assert.deepEqual(view[k], full[k], k);
});

test('un participante que entra a media ronda se pone al día', () => {
  const { clock, feed, sent, run } = setup(4);
  run({ isHost: true }, 'start', {});
  run({ clientId: 'p0' }, 'press', {});
  run({ clientId: 'p1' }, 'press', {});
  const mark = sent.players.length;
  const joinState = feed.full(false); // lo recibe al entrar, antes de que se envíe lo pendiente
  run({ clientId: 'p2' }, 'press', {});
  clock.advance(1000);
  const view = replay(sent.players.slice(mark), mergeState(null, joinState).view);
  assert.deepEqual(view.live.presses.map((p) => p.playerId), ['p0', 'p1', 'p2']);
});

test('si falta información pide sincronizar', () => {
  const { clock, sent, run } = setup(3);
  run({ isHost: true }, 'start', {});
  clock.advance(1000);
  run({ clientId: 'p0' }, 'press', {});
  clock.advance(1000);
  run({ clientId: 'p1' }, 'press', {});
  const last = sent.players.at(-1);
  assert.equal(last.live.from, 1);
  assert.equal(mergeState(null, last).needSync, true);
  assert.equal(mergeState({ version: last.version, live: { number: 1, presses: [] } }, last).needSync, true);
});

test('los envíos durante la ronda son pequeños y ocultan respuestas', () => {
  const { clock, sent, run } = setup(30);
  run({ isHost: true }, 'start', {});
  clock.advance(1000);
  run({ clientId: 'p3' }, 'press', { answer: 'secreto' });
  const msg = sent.players.at(-1);
  assert.equal(msg.ranking, undefined);
  assert.equal(msg.players, undefined);
  assert.equal(msg.live.presses.length, 1);
  assert.equal(msg.live.presses[0].answer, '•••');
  assert.equal(sent.host.at(-1).live.presses[0].answer, 'secreto');
  assert.ok(JSON.stringify(msg).length < 600);
});

test('al cerrar la ronda se revelan las respuestas y la clasificación llega en ≤ 3 s', () => {
  const { clock, sent, run } = setup(3);
  run({ isHost: true }, 'start', {});
  run({ clientId: 'p0' }, 'press', { answer: 'hola' });
  clock.advance(1000);
  run({ isHost: true }, 'close');
  const msg = sent.players.at(-1);
  assert.equal(msg.live.from, 0);
  assert.equal(msg.live.presses[0].answer, 'hola');
  const mark = sent.players.length;
  clock.advance(3000);
  assert.ok(sent.players.slice(mark - 1).some((m) => Array.isArray(m.ranking)));
});

test('la clasificación se envía como máximo cada 3 s aunque se valide rápido', () => {
  const { clock, sent, run } = setup(30);
  run({ isHost: true }, 'start', {});
  for (let i = 0; i < 30; i++) run({ clientId: `p${i}` }, 'press', {});
  run({ isHost: true }, 'close');
  clock.advance(5000);
  const mark = sent.players.length;
  for (let i = 0; i < 30; i++) { clock.advance(300); run({ isHost: true }, 'validate', { round: 1, playerId: `p${i}`, valid: true }); }
  clock.advance(5000);
  const after = sent.players.slice(mark);
  const rankings = after.filter((m) => m.ranking).length;
  assert.ok(rankings <= 5, `clasificación enviada ${rankings} veces en 9 s`);
  assert.ok(after.length >= 25, 'cada validación sigue llegando rápido');
});

test('acciones de solo lectura para el moderador', () => {
  const { game, run } = setup(2);
  run({ isHost: true }, 'start', {});
  run({ clientId: 'p0' }, 'press', { answer: 'x' });
  assert.throws(() => applyAction(game, { clientId: 'p0' }, 'export'), /Solo el moderador/);
  assert.equal(applyAction(game, { isHost: true }, 'export').result.length, 1);
  assert.equal(applyAction(game, { isHost: true }, 'round', { number: 1 }).result.presses[0].answer, 'x');
});

test('validar en la ronda actual manda solo el cambio, no la ronda completa', () => {
  const { clock, feed, sent, run } = setup(20);
  run({ isHost: true }, 'start', {});
  for (let i = 0; i < 20; i++) run({ clientId: `p${i}` }, 'press', { answer: `r${i}` });
  run({ isHost: true }, 'close');
  const before = mergeState(null, feed.full(false)).view;
  clock.advance(1000);
  run({ isHost: true }, 'validate', { round: 1, playerId: 'p5', valid: true });
  const msg = sent.players.at(-1);
  assert.equal(msg.live.presses.length, 0);
  assert.deepEqual(msg.live.patches, [{ playerId: 'p5', valid: true }]);
  const view = replay([msg], before);
  assert.equal(view.live.presses.find((p) => p.playerId === 'p5').valid, true);
  assert.equal(view.live.winnerId, 'p5');
  assert.deepEqual(view.live, mergeState(null, feed.full(false)).view.live);
});

test('los avisos de "ya terminó" viajan agrupados y en orden', () => {
  const { clock, feed, sent, run } = setup(30);
  run({ isHost: true }, 'start', {});
  const mark = sent.players.length;
  for (let i = 0; i < 30; i++) {
    clock.advance(20);
    const out = run({ clientId: `p${i}` }, 'press', {});
    feed.event(out.notify);
  }
  clock.advance(1000);
  const events = sent.players.slice(mark).flatMap((m) => m.events ?? []);
  assert.deepEqual(events.map((e) => e.position), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.ok(sent.players.length - mark <= 5);
  assert.equal(feed.full(false).events, undefined);
});
