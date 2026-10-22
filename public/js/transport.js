// Conexión entre moderador y participantes.
//  - ServerTransport: usa el servidor Node.js (Socket.IO).
//  - P2PTransport: sin servidor propio; el navegador del moderador hace de servidor
//    y los participantes se conectan a él con WebRTC (PeerJS). Ideal para GitHub Pages.
import { Game, GameError } from './game.js';
import { applyAction, randomCode, StateFeed } from './room.js';
import config from './config.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PEER_PREFIX = 'yoyaestoy-v1-';
const ROOM_NOT_FOUND = (code) =>
  `No se encontró la sala ${code}. Verifica el código y que el moderador tenga la página abierta.`;

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); reject(new Error(`No se pudo cargar ${src}. Revisa tu conexión.`)); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

export const savedHost = {
  key: (mode) => `yye:host:${mode}`,
  get(mode) { try { return JSON.parse(localStorage.getItem(this.key(mode))); } catch { return null; } },
  set(mode, v) { try { localStorage.setItem(this.key(mode), JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  clear(mode) { try { localStorage.removeItem(this.key(mode)); } catch { /* sin almacenamiento */ } },
};

function serverUrl() {
  const fromQuery = new URLSearchParams(location.search).get('servidor');
  return (fromQuery || config.serverUrl || '').replace(/\/+$/, '');
}

/** Devuelve 'servidor' o 'p2p'. Se puede forzar con ?modo=p2p o ?modo=servidor. */
export async function detectMode() {
  const forced = new URLSearchParams(location.search).get('modo');
  if (forced === 'p2p' || forced === 'servidor') return forced;
  try {
    const base = serverUrl();
    const res = await fetch(base ? `${base}/api/health` : 'api/health', { cache: 'no-store' });
    if (res.ok && (await res.json()).mode === 'server') return 'servidor';
  } catch { /* no hay servidor */ }
  return 'p2p';
}

export function createTransport(mode) {
  return mode === 'servidor' ? new ServerTransport() : new P2PTransport();
}

class Emitter {
  #handlers = {};
  on(event, fn) { (this.#handlers[event] ??= []).push(fn); }
  emit(event, data) {
    for (const fn of this.#handlers[event] ?? []) {
      try { fn(data); } catch (err) { console.error(err); }
    }
  }
}

// ---------------------------------------------------------------- Servidor Node.js
class ServerTransport extends Emitter {
  socket = null;
  rejoin = null;

  async #init() {
    if (this.socket) return;
    const base = serverUrl();
    await loadScript(base ? `${base}/socket.io/socket.io.js` : 'socket.io/socket.io.js');
    const socket = base ? window.io(base) : window.io();
    this.socket = socket;
    socket.on('state', (s) => this.emit('state', s));
    socket.on('notify', (n) => this.emit('notify', n));
    socket.on('disconnect', () => this.emit('status', { connected: false, message: 'Reconectando con el servidor…' }));
    socket.on('connect', async () => {
      if (this.rejoin) {
        try { await this.rejoin(); } catch (err) {
          this.emit('status', { connected: false, message: err.message });
          return;
        }
      }
      this.emit('status', { connected: true });
    });
    if (!socket.connected) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No se pudo conectar con el servidor.')), 8000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    }
  }

  #call(event, data = {}) {
    return new Promise((resolve, reject) => {
      this.socket.timeout(8000).emit(event, data, (err, resp) => {
        if (err) return reject(new Error('El servidor no respondió. Revisa tu conexión.'));
        if (!resp?.ok) return reject(new GameError(resp?.error ?? 'Error desconocido.'));
        resolve(resp);
      });
    });
  }

  async createRoom() {
    await this.#init();
    const r = await this.#call('host:create');
    const info = { code: r.code, hostToken: r.hostToken };
    savedHost.set('servidor', info);
    this.rejoin = () => this.#call('host:resume', info);
    return { code: r.code };
  }

  async resumeHost(info) {
    await this.#init();
    await this.#call('host:resume', info);
    this.rejoin = () => this.#call('host:resume', info);
    return { code: info.code };
  }

  async join(code, clientId, name) {
    await this.#init();
    const data = { code, clientId, name };
    const r = await this.#call('player:join', data);
    this.rejoin = () => this.#call('player:join', data);
    return r.result;
  }

  async action(action, payload = {}) {
    return (await this.#call('action', { action, payload })).result;
  }

  close() {
    this.rejoin = null;
    this.socket?.disconnect();
  }
}

// ---------------------------------------------------------------- P2P (GitHub Pages)
class P2PTransport extends Emitter {
  peer = null;
  role = null;
  code = null;
  closed = false;
  // moderador
  game = null;
  conns = new Map();
  // participante
  conn = null;
  joined = false;
  joinData = null;
  pending = new Map();
  pendingConnect = null;
  seq = 0;
  reconnectTimer = null;

  async #openPeer(id) {
    await loadScript(PEERJS_URL);
    return new Promise((resolve, reject) => {
      const peer = id ? new window.Peer(id, { debug: 1 }) : new window.Peer({ debug: 1 });
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        peer.destroy();
        reject(new Error('No se pudo conectar con el servicio P2P (PeerJS). Revisa tu conexión a internet.'));
      }, 12000);
      peer.on('open', () => {
        if (!opened) { opened = true; clearTimeout(timer); resolve(peer); }
        this.emit('status', { connected: true });
      });
      peer.on('error', (err) => {
        if (!opened) { clearTimeout(timer); peer.destroy(); reject(err); return; }
        this.#onPeerError(err);
      });
      peer.on('disconnected', () => {
        if (this.closed || peer.destroyed) return;
        if (this.role === 'host') this.emit('status', { connected: false, message: 'Reconectando con el servicio P2P…' });
        setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
      });
    });
  }

  #onPeerError(err) {
    if (err?.type === 'peer-unavailable' && this.pendingConnect) {
      this.pendingConnect.fail(ROOM_NOT_FOUND(this.code));
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err?.type)) {
      this.emit('status', { connected: false, message: 'Problema de red con el servicio P2P…' });
    }
  }

  // ----- Moderador: su navegador guarda el juego y atiende a los participantes
  createRoom() { return this.#host(null); }
  resumeHost(info) { return this.#host(info); }

  async #host(info) {
    let peer = null;
    let code = info?.code ?? null;
    for (let attempt = 0; attempt < 6 && !peer; attempt++) {
      const candidate = code ?? randomCode(5);
      try {
        peer = await this.#openPeer(PEER_PREFIX + candidate);
        code = candidate;
      } catch (err) {
        if (err?.type !== 'unavailable-id') throw new Error(err?.message || 'No se pudo abrir la sala.');
        // Al recargar la página el servicio tarda unos segundos en liberar el código.
        if (info) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!peer) {
      throw new Error(info
        ? `La sala ${code} sigue ocupada en el servicio P2P. Espera unos segundos y vuelve a intentarlo.`
        : 'No se pudo reservar un código de sala. Inténtalo de nuevo.');
    }
    this.peer = peer;
    this.role = 'host';
    this.code = code;
    this.game = info?.game ? Game.fromJSON(info.game) : new Game();
    this.feed = new StateFeed(this.game, (hostMsg, playerMsg) => {
      this.#broadcast({ type: 'state', state: playerMsg });
      this.emit('state', hostMsg);
      savedHost.set('p2p', { code: this.code, game: this.game.toJSON() });
    });
    peer.on('connection', (conn) => this.#onConnection(conn));
    this.emit('state', this.feed.full(true));
    savedHost.set('p2p', { code: this.code, game: this.game.toJSON() });
    return { code };
  }

  #onConnection(conn) {
    conn.on('data', (msg) => this.#onHostMessage(conn, msg));
    conn.on('close', () => {
      const cid = conn.clientId;
      if (cid && this.conns.get(cid) === conn) {
        this.conns.delete(cid);
        this.game.setConnected(cid, false);
        this.feed.changed(['players', 'ranking']);
      }
    });
    conn.on('error', () => {});
  }

  #onHostMessage(conn, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.action !== 'string') return;
    const reply = (body) => { try { conn.send({ type: 'reply', id: msg.id, ...body }); } catch { /* conexión cerrada */ } };
    try {
      if (msg.action === 'join') {
        const cid = String(msg.payload?.clientId || conn.peer).slice(0, 80);
        const previous = this.conns.get(cid);
        conn.clientId = cid;
        this.conns.set(cid, conn);
        if (previous && previous !== conn) previous.close();
      }
      if (!conn.clientId) throw new GameError('Primero registra tu nombre.');
      if (msg.action === 'sync') { reply({ ok: true, result: this.feed.full(false) }); return; }
      const out = applyAction(this.game, { clientId: conn.clientId, isHost: false }, msg.action, msg.payload ?? {});
      reply({ ok: true, result: out.result });
      if (msg.action === 'join') { try { conn.send({ type: 'state', state: this.feed.full(false) }); } catch { /* cerrada */ } }
      this.#changed(out);
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply({ ok: false, error: err instanceof GameError ? err.message : 'Error inesperado.' });
    }
  }

  #changed({ notify, parts, urgent, patch }) {
    // El aviso "ya terminó" viaja agrupado con el siguiente estado; los demás salen al instante.
    if (notify?.kind === 'press') this.feed.event(notify);
    else if (notify) {
      this.emit('notify', notify);
      this.#broadcast({ type: 'notify', notify });
    }
    this.feed.changed(parts, { urgent, patch });
  }

  #broadcast(msg) {
    for (const c of this.conns.values()) {
      if (c.open) { try { c.send(msg); } catch { /* conexión cerrada */ } }
    }
  }

  // ----- Participante
  async join(code, clientId, name) {
    this.role = 'player';
    this.code = code;
    this.joinData = { clientId, name };
    await this.#connectToHost();
    const result = await this.#request('join', this.joinData);
    this.joined = true;
    return result;
  }

  async #connectToHost() {
    if (!this.peer || this.peer.destroyed) this.peer = await this.#openPeer(null);
    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true });
      // Si se agota el tiempo sin "peer-unavailable", la sala existe pero la red bloquea WebRTC.
      const timer = setTimeout(() => fail(
        `Se encontró la sala ${this.code}, pero la red no permitió la conexión directa (WebRTC). `
        + 'Prueba con otra red (p. ej. datos móviles) o usa el modo servidor.',
      ), 15000);
      const fail = (message) => {
        clearTimeout(timer);
        this.pendingConnect = null;
        try { conn.close(); } catch { /* nada */ }
        reject(new Error(message));
      };
      this.pendingConnect = { fail };
      conn.on('open', () => {
        clearTimeout(timer);
        this.pendingConnect = null;
        this.conn = conn;
        this.emit('status', { connected: true });
        resolve();
      });
      conn.on('data', (m) => this.#onPlayerData(m));
      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.conn = null;
        this.#rejectPending('Se perdió la conexión con el moderador.');
        if (this.closed) return;
        this.emit('status', { connected: false, message: 'Reconectando con el moderador…' });
        if (this.joined) this.#scheduleReconnect();
      });
      conn.on('error', () => {});
    });
  }

  #scheduleReconnect(delay = 2000) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.closed || this.conn) return;
      try {
        await this.#connectToHost();
        await this.#request('join', this.joinData);
      } catch {
        this.#scheduleReconnect(Math.min(delay * 1.5, 10000));
      }
    }, delay);
  }

  #request(action, payload) {
    return new Promise((resolve, reject) => {
      if (!this.conn?.open) return reject(new Error('Sin conexión con el moderador. Reintentando…'));
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('El moderador no respondió.')); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.conn.send({ id, action, payload });
    });
  }

  #onPlayerData(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reply') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new GameError(m.error));
    } else if (m.type === 'state') {
      this.emit('state', m.state);
    } else if (m.type === 'notify') {
      this.emit('notify', m.notify);
    }
  }

  #rejectPending(message) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }

  // ----- Común
  async action(action, payload = {}) {
    if (this.role === 'host') {
      if (action === 'sync') return this.feed.full(true);
      const out = applyAction(this.game, { clientId: 'host', isHost: true }, action, payload);
      this.#changed(out);
      return out.result;
    }
    return this.#request(action, payload);
  }

  close() {
    this.closed = true;
    this.feed?.dispose();
    clearTimeout(this.reconnectTimer);
    try { this.peer?.destroy(); } catch { /* nada */ }
  }
}
