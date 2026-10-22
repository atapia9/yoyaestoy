// Lógica del juego "¡Yo ya estoy!". Funciona igual en el navegador y en Node.js.

export const MAX_ROUNDS = 10;
export const POINTS_WINNER = 3; // primer participante con respuesta correcta
export const POINTS_CORRECT = 1; // cualquier otra respuesta correcta

export class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
  }
}

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function roundWinner(round) {
  return round.presses
    .filter((p) => p.valid === true)
    .sort((a, b) => a.elapsedMs - b.elapsedMs)[0] ?? null;
}

/** Fila del resumen de rondas (pequeña: no incluye la lista de participaciones). */
export function summarizeRound(round) {
  const first = round.presses[0];
  const winner = roundWinner(round);
  return {
    number: round.number,
    question: round.question,
    status: round.status,
    count: round.presses.length,
    pending: round.presses.some((p) => p.valid === null),
    first: first ? { name: first.name, elapsedMs: first.elapsedMs } : null,
    winner: winner ? { playerId: winner.playerId, name: winner.name, elapsedMs: winner.elapsedMs } : null,
  };
}

export class Game {
  constructor({ now = () => Date.now(), maxRounds = MAX_ROUNDS } = {}) {
    this.now = now;
    this.maxRounds = maxRounds;
    this.players = new Map();
    this.rounds = [];
  }

  get current() {
    const last = this.rounds.at(-1);
    return last && last.status === 'open' ? last : null;
  }

  get finished() {
    return this.rounds.length >= this.maxRounds && !this.current;
  }

  addPlayer(id, rawName) {
    const name = clean(rawName, 30);
    if (!id) throw new GameError('Falta el identificador del participante.');
    if (!name) throw new GameError('Escribe tu nombre para participar.');
    const sameName = [...this.players.values()].find(
      (p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase(),
    );

    const existing = this.players.get(id);
    if (existing) {
      if (sameName) throw new GameError(`El nombre "${name}" ya está en uso en esta sala.`);
      existing.name = name;
      existing.connected = true;
      return existing;
    }

    if (sameName) {
      if (sameName.connected) throw new GameError(`El nombre "${name}" ya está en uso en esta sala.`);
      // Alguien que se desconectó vuelve con el mismo nombre: conserva su historial.
      this.players.delete(sameName.id);
      for (const r of this.rounds) {
        for (const p of r.presses) if (p.playerId === sameName.id) p.playerId = id;
      }
      sameName.id = id;
      sameName.connected = true;
      this.players.set(id, sameName);
      return sameName;
    }

    const player = { id, name, connected: true, joinedAt: this.now() };
    this.players.set(id, player);
    return player;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (p) p.connected = connected;
  }

  startRound(rawQuestion) {
    if (this.current) throw new GameError('Ya hay una ronda en curso.');
    if (this.rounds.length >= this.maxRounds) {
      throw new GameError(`Se alcanzó el máximo de ${this.maxRounds} rondas. Reinicia el juego para empezar de nuevo.`);
    }
    const round = {
      number: this.rounds.length + 1,
      question: clean(rawQuestion, 200),
      startedAt: this.now(),
      endedAt: null,
      status: 'open',
      presses: [],
    };
    this.rounds.push(round);
    return round;
  }

  press(playerId, rawAnswer) {
    const round = this.current;
    if (!round) throw new GameError('No hay una ronda activa.');
    const player = this.players.get(playerId);
    if (!player) throw new GameError('Primero registra tu nombre.');
    if (round.presses.some((p) => p.playerId === playerId)) {
      throw new GameError('Ya registraste tu participación en esta ronda.');
    }
    const at = this.now();
    const press = {
      playerId,
      name: player.name,
      at,
      elapsedMs: Math.max(0, at - round.startedAt),
      answer: clean(rawAnswer, 200),
      valid: null,
      position: round.presses.length + 1,
    };
    round.presses.push(press);
    return press;
  }

  closeRound() {
    const round = this.current;
    if (!round) throw new GameError('No hay una ronda en curso.');
    round.status = 'closed';
    round.endedAt = this.now();
    return round;
  }

  /** Borra los registros de la última ronda y vuelve a arrancar su cronómetro. */
  resetRound() {
    const round = this.rounds.at(-1);
    if (!round) throw new GameError('Todavía no hay rondas para reiniciar.');
    round.presses = [];
    round.status = 'open';
    round.startedAt = this.now();
    round.endedAt = null;
    return round;
  }

  /** Borra todas las rondas. Los participantes conectados se quedan en la sala. */
  resetGame() {
    this.rounds = [];
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
  }

  validate(roundNumber, playerId, valid) {
    const round = this.rounds[Number(roundNumber) - 1];
    if (!round) throw new GameError('Esa ronda no existe.');
    const press = round.presses.find((p) => p.playerId === playerId);
    if (!press) throw new GameError('Ese participante no presionó en esta ronda.');
    press.valid = valid === null || valid === undefined ? null : Boolean(valid);
    return press;
  }

  ranking() {
    const rows = new Map();
    const row = (id, name, connected = false) => {
      if (!rows.has(id)) {
        rows.set(id, {
          playerId: id, name, connected,
          points: 0, wins: 0, correct: 0, wrong: 0, presses: 0, firsts: 0,
          totalCorrectMs: 0, totalMs: 0, bestMs: null,
        });
      }
      return rows.get(id);
    };
    for (const p of this.players.values()) row(p.id, p.name, p.connected);

    for (const round of this.rounds) {
      const winner = roundWinner(round);
      for (const p of round.presses) {
        const r = row(p.playerId, p.name);
        r.presses += 1;
        r.totalMs += p.elapsedMs;
        if (p.position === 1) r.firsts += 1;
        if (p.valid === true) {
          r.correct += 1;
          r.totalCorrectMs += p.elapsedMs;
          r.bestMs = r.bestMs === null ? p.elapsedMs : Math.min(r.bestMs, p.elapsedMs);
          r.points += winner?.playerId === p.playerId ? POINTS_WINNER : POINTS_CORRECT;
          if (winner?.playerId === p.playerId) r.wins += 1;
        } else if (p.valid === false) {
          r.wrong += 1;
        }
      }
    }

    const nullsLast = (a, b) => (a ?? Infinity) - (b ?? Infinity);
    return [...rows.values()]
      .map(({ totalCorrectMs, totalMs, ...r }) => ({
        ...r,
        avgCorrectMs: r.correct ? Math.round(totalCorrectMs / r.correct) : null,
        avgMs: r.presses ? Math.round(totalMs / r.presses) : null,
      }))
      .sort((a, b) =>
        b.points - a.points
        || b.wins - a.wins
        || b.correct - a.correct
        || nullsLast(a.avgCorrectMs, b.avgCorrectMs)
        || nullsLast(a.avgMs, b.avgMs)
        || a.name.localeCompare(b.name, 'es'))
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  /**
   * Estado serializable para las pantallas. Las respuestas de una ronda abierta
   * solo las ve el moderador; se revelan a todos al cerrar la ronda.
   */
  snapshot({ includeAnswers = false } = {}) {
    return {
      serverNow: this.now(),
      maxRounds: this.maxRounds,
      finished: this.finished,
      players: [...this.players.values()].map(({ id, name, connected }) => ({ id, name, connected })),
      rounds: this.rounds.map((r) => {
        const reveal = includeAnswers || r.status === 'closed';
        return {
          ...r,
          winnerId: roundWinner(r)?.playerId ?? null,
          presses: r.presses.map((p) => ({ ...p, answer: reveal ? p.answer : (p.answer ? '•••' : '') })),
        };
      }),
      ranking: this.ranking(),
    };
  }

  publicPlayers() {
    return [...this.players.values()].map(({ id, name, connected }) => ({ id, name, connected }));
  }

  /**
   * Vista de una ronda. `from` permite mandar solo las participaciones nuevas.
   * Las respuestas se ocultan a los participantes mientras la ronda está abierta.
   */
  roundView(round, { includeAnswers = false, from = 0 } = {}) {
    const reveal = includeAnswers || round.status === 'closed';
    return {
      number: round.number,
      question: round.question,
      startedAt: round.startedAt,
      endedAt: round.endedAt,
      status: round.status,
      winnerId: roundWinner(round)?.playerId ?? null,
      from,
      presses: round.presses.slice(from).map((p) => (reveal ? { ...p } : { ...p, answer: p.answer ? '•••' : '' })),
    };
  }

  toJSON() {
    return { v: 1, maxRounds: this.maxRounds, players: [...this.players.values()], rounds: this.rounds };
  }

  static fromJSON(data, opts = {}) {
    const game = new Game({ ...opts, maxRounds: data?.maxRounds ?? MAX_ROUNDS });
    for (const p of data?.players ?? []) game.players.set(p.id, { ...p, connected: false });
    game.rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    return game;
  }
}

/** Bitácora en CSV (separador coma, UTF-8 con BOM para que Excel respete acentos). */
export function roundsToCSV(rounds) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const label = (v) => (v === true ? 'Correcta' : v === false ? 'Incorrecta' : 'Sin validar');
  const lines = [['Ronda', 'Actividad', 'Posición', 'Nombre', 'Tiempo (s)', 'Respuesta', 'Validación', 'Ganador de la ronda', 'Hora'].map(q).join(',')];
  for (const r of rounds) {
    const winner = roundWinner(r);
    for (const p of r.presses) {
      lines.push([
        r.number, r.question, p.position, p.name, (p.elapsedMs / 1000).toFixed(3), p.answer,
        label(p.valid), winner?.playerId === p.playerId ? 'Sí' : '', new Date(p.at).toLocaleString('es-MX'),
      ].map(q).join(','));
    }
  }
  return '﻿' + lines.join('\r\n');
}
