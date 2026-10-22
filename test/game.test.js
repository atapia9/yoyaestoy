import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, roundsToCSV, MAX_ROUNDS } from '../public/js/game.js';
import { applyAction, randomCode } from '../public/js/room.js';

function setup() {
  let t = 1_000;
  const clock = { advance: (ms) => { t += ms; } };
  const game = new Game({ now: () => t });
  game.addPlayer('a', 'Ana');
  game.addPlayer('b', 'Beto');
  game.addPlayer('c', 'Carla');
  return { game, clock };
}

test('registra el orden y el tiempo de quien presiona', () => {
  const { game, clock } = setup();
  game.startRound('Ejercicio 1');
  clock.advance(1500);
  game.press('b', '42');
  clock.advance(500);
  game.press('a', '41');
  const r = game.current;
  assert.deepEqual(r.presses.map((p) => [p.name, p.position, p.elapsedMs]), [['Beto', 1, 1500], ['Ana', 2, 2000]]);
});

test('no permite presionar dos veces ni sin ronda activa', () => {
  const { game } = setup();
  assert.throws(() => game.press('a'), GameError);
  game.startRound();
  game.press('a');
  assert.throws(() => game.press('a'), /Ya registraste/);
  game.closeRound();
  assert.throws(() => game.press('b'), /No hay una ronda activa/);
});

test('pide nombre y evita nombres repetidos', () => {
  const { game } = setup();
  assert.throws(() => game.addPlayer('x', '   '), /Escribe tu nombre/);
  assert.throws(() => game.addPlayer('x', 'ana'), /ya está en uso/);
});

test('quien vuelve con el mismo nombre conserva su historial', () => {
  const { game } = setup();
  game.startRound();
  game.press('a');
  game.setConnected('a', false);
  game.addPlayer('a2', 'Ana');
  assert.equal(game.current.presses[0].playerId, 'a2');
  assert.equal(game.players.size, 3);
});

test('máximo de 10 rondas', () => {
  const { game } = setup();
  for (let i = 0; i < MAX_ROUNDS; i++) { game.startRound(); game.closeRound(); }
  assert.equal(game.finished, true);
  assert.throws(() => game.startRound(), /máximo de 10 rondas/);
});

test('el ganador es el primero con respuesta correcta y suma 3 pts', () => {
  const { game, clock } = setup();
  game.startRound();
  clock.advance(1000); game.press('a', 'mal');
  clock.advance(1000); game.press('b', 'bien');
  clock.advance(1000); game.press('c', 'bien');
  game.closeRound();
  game.validate(1, 'a', false);
  game.validate(1, 'b', true);
  game.validate(1, 'c', true);
  const rank = game.ranking();
  assert.deepEqual(rank.map((r) => [r.name, r.points, r.wins]), [['Beto', 3, 1], ['Carla', 1, 0], ['Ana', 0, 0]]);
  assert.equal(game.snapshot().rounds[0].winnerId, 'b');
  assert.equal(rank.find((r) => r.name === 'Ana').firsts, 1);
});

test('empate en puntos se decide por tiempo promedio', () => {
  const { game, clock } = setup();
  game.startRound(); clock.advance(3000); game.press('a', 'x'); game.closeRound(); game.validate(1, 'a', true);
  game.startRound(); clock.advance(1000); game.press('b', 'x'); game.closeRound(); game.validate(2, 'b', true);
  assert.deepEqual(game.ranking().slice(0, 2).map((r) => r.name), ['Beto', 'Ana']);
});

test('reiniciar ronda borra registros y reinicia el cronómetro', () => {
  const { game, clock } = setup();
  game.startRound('Q');
  clock.advance(2000);
  game.press('a');
  game.closeRound();
  clock.advance(5000);
  const r = game.resetRound();
  assert.equal(r.status, 'open');
  assert.equal(r.presses.length, 0);
  clock.advance(700);
  assert.equal(game.press('a').elapsedMs, 700);
  assert.equal(game.rounds.length, 1);
});

test('reiniciar juego borra rondas pero conserva conectados', () => {
  const { game } = setup();
  game.setConnected('c', false);
  game.startRound(); game.press('a');
  game.resetGame();
  assert.equal(game.rounds.length, 0);
  assert.deepEqual([...game.players.keys()], ['a', 'b']);
});

test('las respuestas se ocultan a participantes mientras la ronda está abierta', () => {
  const { game } = setup();
  game.startRound();
  game.press('a', 'secreto');
  assert.equal(game.snapshot().rounds[0].presses[0].answer, '•••');
  assert.equal(game.snapshot({ includeAnswers: true }).rounds[0].presses[0].answer, 'secreto');
  game.closeRound();
  assert.equal(game.snapshot().rounds[0].presses[0].answer, 'secreto');
});

test('toJSON / fromJSON conserva el juego', () => {
  const { game } = setup();
  game.startRound('Q'); game.press('a', 'r'); game.closeRound(); game.validate(1, 'a', true);
  const copy = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
  assert.deepEqual(copy.ranking().map((r) => [r.name, r.points]), game.ranking().map((r) => [r.name, r.points]));
});

test('CSV incluye encabezados y comillas escapadas', () => {
  const { game } = setup();
  game.startRound('Di "hola"'); game.press('a', 'a,b');
  const csv = roundsToCSV(game.rounds);
  assert.match(csv, /"Ronda","Actividad"/);
  assert.match(csv, /"Di ""hola"""/);
  assert.match(csv, /"a,b"/);
});

test('solo el moderador controla las rondas', () => {
  const { game } = setup();
  assert.throws(() => applyAction(game, { clientId: 'a', isHost: false }, 'start'), /Solo el moderador/);
  const out = applyAction(game, { clientId: 'host', isHost: true }, 'start', { question: 'Q' });
  assert.equal(out.notify.kind, 'start');
  const press = applyAction(game, { clientId: 'a', isHost: false }, 'press', { answer: '1' });
  assert.deepEqual([press.notify.kind, press.notify.name, press.notify.position], ['press', 'Ana', 1]);
});

test('validar avisa al grupo cuando cambia el ganador', () => {
  const { game } = setup();
  applyAction(game, { isHost: true }, 'start');
  applyAction(game, { clientId: 'a' }, 'press');
  const out = applyAction(game, { isHost: true }, 'validate', { round: 1, playerId: 'a', valid: true });
  assert.equal(out.notify.kind, 'winner');
  const again = applyAction(game, { isHost: true }, 'validate', { round: 1, playerId: 'a', valid: true });
  assert.equal(again.notify, undefined);
});

test('códigos de sala sin caracteres confusos', () => {
  for (let i = 0; i < 200; i++) assert.match(randomCode(5), /^[A-HJ-NP-Z2-9]{5}$/);
});
