// Protocolo de acciones de una sala. Lo usan el servidor Node.js y el moderador en modo P2P.
import { GameError, roundWinner } from './game.js';

const HOST_ACTIONS = new Set(['start', 'close', 'resetRound', 'resetGame', 'validate']);

/**
 * Aplica una acción al juego.
 * Devuelve { result, notify } donde notify (opcional) es el aviso para todo el grupo.
 */
export function applyAction(game, { clientId, isHost }, action, payload = {}) {
  if (HOST_ACTIONS.has(action) && !isHost) throw new GameError('Solo el moderador puede hacer esto.');

  switch (action) {
    case 'join': {
      if (isHost) throw new GameError('El moderador no participa como jugador.');
      const p = game.addPlayer(clientId, payload.name);
      return { result: { playerId: p.id, name: p.name } };
    }
    case 'press': {
      const press = game.press(clientId, payload.answer);
      const round = game.current;
      return {
        result: press,
        notify: { kind: 'press', round: round.number, name: press.name, position: press.position, elapsedMs: press.elapsedMs },
      };
    }
    case 'start': {
      const r = game.startRound(payload.question);
      return { result: { number: r.number }, notify: { kind: 'start', round: r.number, question: r.question } };
    }
    case 'close': {
      const r = game.closeRound();
      return { result: { number: r.number }, notify: { kind: 'close', round: r.number, presses: r.presses.length } };
    }
    case 'resetRound': {
      const r = game.resetRound();
      return { result: { number: r.number }, notify: { kind: 'resetRound', round: r.number } };
    }
    case 'resetGame': {
      game.resetGame();
      return { result: true, notify: { kind: 'resetGame' } };
    }
    case 'validate': {
      const round = game.rounds[Number(payload.round) - 1];
      const before = round ? roundWinner(round)?.playerId : null;
      game.validate(payload.round, payload.playerId, payload.valid);
      const winner = roundWinner(round);
      const notify = winner && winner.playerId !== before
        ? { kind: 'winner', round: round.number, name: winner.name, elapsedMs: winner.elapsedMs }
        : undefined;
      return { result: true, notify };
    }
    default:
      throw new GameError('Acción desconocida.');
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para evitar confusiones

export function randomCode(length = 4) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
