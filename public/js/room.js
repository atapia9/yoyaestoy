// Protocolo de una sala. Lo usan el servidor Node.js y el moderador en modo P2P.
import { GameError, roundWinner, summarizeRound } from './game.js';

const HOST_ACTIONS = new Set(['start', 'close', 'resetRound', 'resetGame', 'validate', 'export', 'round']);

/**
 * Aplica una acción al juego.
 * Devuelve { result, notify, parts, urgent }:
 *  - notify: aviso inmediato para todo el grupo (opcional).
 *  - parts: qué partes del estado cambiaron ('live' = la ronda actual cambió algo más que
 *    agregar participaciones; 'history', 'ranking', 'players'). null = no cambió nada.
 *  - urgent: enviar el estado de inmediato en lugar de agruparlo.
 *  - patch: cambio de validación en la ronda actual (se manda solo ese dato).
 */
export function applyAction(game, { clientId, isHost }, action, payload = {}) {
  if (HOST_ACTIONS.has(action) && !isHost) throw new GameError('Solo el moderador puede hacer esto.');

  switch (action) {
    case 'join': {
      if (isHost) throw new GameError('El moderador no participa como jugador.');
      const p = game.addPlayer(clientId, payload.name);
      return { result: { playerId: p.id, name: p.name }, parts: ['players', 'ranking'] };
    }
    case 'press': {
      const press = game.press(clientId, payload.answer);
      const round = game.current;
      return {
        result: press,
        notify: { kind: 'press', round: round.number, name: press.name, position: press.position, elapsedMs: press.elapsedMs },
        parts: [],
      };
    }
    case 'start': {
      const r = game.startRound(payload.question);
      return {
        result: { number: r.number },
        notify: { kind: 'start', round: r.number, question: r.question },
        parts: ['live', 'history'],
        urgent: true,
      };
    }
    case 'close': {
      const r = game.closeRound();
      return {
        result: { number: r.number },
        notify: { kind: 'close', round: r.number, presses: r.presses.length },
        parts: ['live', 'history', 'ranking'],
        urgent: true,
      };
    }
    case 'resetRound': {
      const r = game.resetRound();
      return {
        result: { number: r.number },
        notify: { kind: 'resetRound', round: r.number },
        parts: ['live', 'history', 'ranking'],
        urgent: true,
      };
    }
    case 'resetGame': {
      game.resetGame();
      return { result: true, notify: { kind: 'resetGame' }, parts: ['live', 'history', 'ranking', 'players'], urgent: true };
    }
    case 'validate': {
      const round = game.rounds[Number(payload.round) - 1];
      const before = round ? roundWinner(round)?.playerId : null;
      game.validate(payload.round, payload.playerId, payload.valid);
      const winner = roundWinner(round);
      const notify = winner && winner.playerId !== before
        ? { kind: 'winner', round: round.number, name: winner.name, elapsedMs: winner.elapsedMs }
        : undefined;
      const isLive = round === game.rounds.at(-1);
      return {
        result: game.roundView(round, { includeAnswers: true }),
        notify,
        parts: isLive ? ['ranking'] : ['history', 'ranking'],
        // En la ronda actual solo se manda el cambio de esa respuesta, no la ronda completa.
        patch: isLive ? { playerId: payload.playerId, valid: payload.valid ?? null } : undefined,
      };
    }
    case 'round': {
      const round = game.rounds[Number(payload.number) - 1];
      if (!round) throw new GameError('Esa ronda no existe.');
      return { result: game.roundView(round, { includeAnswers: true }), parts: null };
    }
    case 'export':
      return { result: game.rounds, parts: null };
    default:
      throw new GameError('Acción desconocida.');
  }
}

const ALL_PARTS = ['live', 'history', 'ranking', 'players'];

/**
 * Agrupa los envíos del estado. En lugar de mandar todo el juego a todos en cada presión:
 *  - manda como máximo un estado cada `interval` ms (las acciones del moderador salen al instante),
 *  - de la ronda actual solo manda las participaciones nuevas,
 *  - el historial, la clasificación y la lista de participantes solo cuando cambian,
 *  - la clasificación (la parte más pesada) como máximo cada `rankingInterval` ms.
 * `publish(hostMsg, playerMsg)` hace el envío real.
 */
export class StateFeed {
  constructor(game, publish, { interval = 250, rankingInterval = 3000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { game, publish, interval, rankingInterval, now, setTimer, clearTimer });
    this.rankingAt = -Infinity;
    this.timer = null;
    this.lastAt = -Infinity;
    this.dirty = new Set(ALL_PARTS);
    this.sent = 0; // participaciones de la ronda actual ya enviadas
    this.version = 0; // cambia cuando la ronda actual se debe reemplazar completa
    this.liveRef = undefined;
    this.patches = new Map(); // playerId -> validación, pendientes de enviar
    this.events = []; // avisos de "ya terminó" que salen con el siguiente envío
  }

  /** Agrega un aviso de presión al siguiente envío agrupado. */
  event(notify) {
    this.events.push(notify);
    this.changed([]);
  }

  changed(parts, { urgent = false, patch } = {}) {
    if (!parts) return;
    for (const p of parts) this.dirty.add(p);
    if (patch) this.patches.set(patch.playerId, patch.valid);
    if (urgent) { this.flush(); return; }
    const at = this.lastAt + this.interval;
    if (at <= this.now()) { this.flush(); return; }
    this.#schedule(at);
  }

  /** Programa un envío a la hora `at`, salvo que ya haya uno programado antes. */
  #schedule(at) {
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timerAt = at;
    this.timer = this.setTimer(() => this.flush(), Math.max(0, at - this.now()));
  }

  flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.lastAt = this.now();
    const live = this.game.rounds.at(-1) ?? null;
    if (live !== this.liveRef) { this.liveRef = live; this.dirty.add('live'); }
    let from = this.sent;
    if (this.dirty.has('live')) { this.version += 1; from = 0; }
    const parts = this.dirty;
    this.dirty = new Set();
    const deferRanking = parts.has('ranking') && this.lastAt - this.rankingAt < this.rankingInterval;
    if (deferRanking) parts.delete('ranking');
    else if (parts.has('ranking')) this.rankingAt = this.lastAt;
    // Si la ronda se reenvía completa, ya incluye las validaciones.
    const patches = from === 0 || !this.patches.size ? null : [...this.patches].map(([playerId, valid]) => ({ playerId, valid }));
    this.patches = new Map();
    const cache = {};
    const hostMsg = this.#build({ includeAnswers: true, full: false, from, parts, cache, patches });
    const playerMsg = this.#build({ includeAnswers: false, full: false, from, parts, cache, patches });
    if (this.events.length) { hostMsg.events = this.events; playerMsg.events = this.events; this.events = []; }
    this.sent = live ? live.presses.length : 0;
    this.publish(hostMsg, playerMsg);
    if (deferRanking) {
      this.dirty.add('ranking');
      this.#schedule(this.rankingAt + this.rankingInterval);
    }
  }

  /** Estado completo, para quien se acaba de conectar o pide sincronizar. */
  full(includeAnswers) {
    return this.#build({ includeAnswers, full: true, from: 0, parts: new Set(ALL_PARTS), cache: {} });
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  #build({ includeAnswers, full, from, parts, cache, patches = null }) {
    const g = this.game;
    const live = g.rounds.at(-1) ?? null;
    const msg = {
      full,
      version: this.version,
      serverNow: g.now(),
      maxRounds: g.maxRounds,
      finished: g.finished,
      roundsPlayed: g.rounds.length,
      live: live ? g.roundView(live, { includeAnswers, from }) : null,
    };
    if (msg.live && patches) msg.live.patches = patches;
    if (parts.has('history')) msg.history = cache.history ??= g.rounds.slice(0, -1).map(summarizeRound);
    if (parts.has('ranking')) msg.ranking = cache.ranking ??= g.ranking();
    if (parts.has('players')) msg.players = cache.players ??= g.publicPlayers();
    return msg;
  }
}

/**
 * Une un estado recibido (completo o con diferencias) con el que ya tiene la pantalla.
 * Devuelve { view } o { needSync: true } si falta información y hay que pedir el estado completo.
 */
export function mergeState(prev, msg) {
  if (msg.full) {
    const { events, ...rest } = msg;
    return { view: { ...rest, live: msg.live && { ...msg.live, from: 0 } } };
  }
  if (!prev) return { needSync: true };
  const view = {
    ...prev,
    full: false,
    version: msg.version,
    serverNow: msg.serverNow,
    maxRounds: msg.maxRounds,
    finished: msg.finished,
    roundsPlayed: msg.roundsPlayed,
  };
  delete view.events;
  for (const k of ['history', 'ranking', 'players']) if (msg[k]) view[k] = msg[k];
  if (!msg.live) {
    view.live = null;
  } else if (msg.live.from === 0) {
    view.live = msg.live;
  } else {
    const old = prev.live;
    if (!old || msg.version !== prev.version || old.number !== msg.live.number || msg.live.from > old.presses.length) {
      return { needSync: true };
    }
    view.live = { ...msg.live, from: 0, presses: old.presses.slice(0, msg.live.from).concat(msg.live.presses) };
  }
  if (view.live?.patches) {
    const changes = new Map(view.live.patches.map((x) => [x.playerId, x.valid]));
    view.live.presses = view.live.presses.map((p) => (changes.has(p.playerId) ? { ...p, valid: changes.get(p.playerId) } : p));
    delete view.live.patches;
  }
  return { view };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para evitar confusiones

export function randomCode(length = 4) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
