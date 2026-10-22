// Interfaz de "¡Yo ya estoy!": pantallas de inicio, moderador y participante.
import { roundsToCSV, summarizeRound, POINTS_WINNER, POINTS_CORRECT } from './game.js';
import { mergeState } from './room.js';
import { detectMode, createTransport, savedHost } from './transport.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')} min`;
}

const session = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* nada */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* nada */ } },
};

function clientId() {
  let id = session.get('yye:cid');
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    session.set('yye:cid', id);
  }
  return id;
}

const app = {
  mode: null,
  transport: null,
  role: null, // 'host' | 'player'
  code: null,
  me: null, // id del participante
  name: null,
  snap: null, // estado que muestra la pantalla (se arma uniendo los envíos del servidor)
  myPress: null, // mi participación, mostrada al instante sin esperar el siguiente estado
  vdData: null, // ronda que muestra la ventana de validación
  syncing: false,
  offset: 0, // diferencia de reloj con el servidor / moderador
  vdRound: null,
};

// ------------------------------------------------------------------ Avisos
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 5000 : 3500);
  while ($('#toasts').children.length > 4) $('#toasts').firstElementChild.remove();
}

let audioCtx = null;
function unlockAudio() {
  try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* sin audio */ }
}
function beep(freq = 880, duration = 0.15, when = 0) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function systemNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try { new Notification(title, { body, tag: 'yoyaestoy' }); } catch { /* algunos móviles no lo permiten */ }
}

function onNotify(n) {
  switch (n.kind) {
    case 'start':
      toast(`▶ Ronda ${n.round} iniciada${n.question ? `: ${n.question}` : ''}`);
      beep(660, 0.12); beep(990, 0.18, 0.14);
      systemNotify(`Ronda ${n.round} iniciada`, n.question || '¡Ya puedes presionar al terminar!');
      if (app.role === 'player') setTimeout(() => $('#answerInput').focus({ preventScroll: true }), 50);
      break;
    case 'press': {
      const first = n.position === 1;
      toast(`${first ? '🥇' : '✅'} ${n.name} ya terminó · #${n.position} · ${fmt(n.elapsedMs)}`, first ? 'first' : '');
      beep(first ? 1175 : 880, first ? 0.25 : 0.12);
      if (first) navigator.vibrate?.(120);
      systemNotify('¡Yo ya estoy!', `${n.name} terminó${first ? ' primero' : ` (#${n.position})`} · ${fmt(n.elapsedMs)}`);
      break;
    }
    case 'close':
      toast(`⏹ Ronda ${n.round} cerrada · ${n.presses} participación(es)`);
      beep(440, 0.2);
      break;
    case 'winner':
      toast(`🏆 ${n.name} gana la ronda ${n.round} (${fmt(n.elapsedMs)})`, 'ok');
      beep(784, 0.12); beep(1047, 0.25, 0.13);
      systemNotify(`Ganador de la ronda ${n.round}`, `${n.name} · ${fmt(n.elapsedMs)}`);
      break;
    case 'resetRound':
      app.myPress = null;
      toast(`↺ Ronda ${n.round} reiniciada: el cronómetro volvió a cero`);
      break;
    case 'resetGame':
      app.myPress = null;
      toast('⟲ Juego reiniciado');
      break;
  }
}

// Avisos de "ya terminó" que llegan juntos. Con pocos se muestra cada uno; con muchos, un resumen.
function onPressEvents(events) {
  if (events.length <= 3) { events.forEach(onNotify); return; }
  const first = events.find((n) => n.position === 1);
  if (first) onNotify(first);
  const rest = events.length - (first ? 1 : 0);
  const last = events.at(-1);
  toast(`✅ ${rest} persona${rest === 1 ? '' : 's'} más ya terminaron · van ${last.position}`);
  if (!first) beep(880, 0.12);
}

function onStatus({ connected, message }) {
  const b = $('#connBadge');
  b.hidden = false;
  b.className = `badge ${connected ? 'on' : 'off'}`;
  b.textContent = connected ? '● Conectado' : `○ ${message || 'Sin conexión'}`;
}

// ------------------------------------------------------------------ Pantallas
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${screen}`;
  $('#btnLeave').hidden = screen === 'home';
}

function wire(t) {
  t.on('state', (msg) => {
    if (msg.events?.length) onPressEvents(msg.events);
    const { view, needSync } = mergeState(app.snap, msg);
    if (needSync) { requestSync(); return; }
    app.snap = view;
    app.offset = msg.serverNow - Date.now();
    render();
  });
  t.on('notify', onNotify);
  t.on('status', onStatus);
}

function shareUrl(code) {
  const url = new URL(location.href);
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (k !== 'modo' && k !== 'servidor') url.searchParams.delete(k);
  url.searchParams.set('sala', code);
  return url.toString();
}

async function startHost(resume) {
  const btns = [$('#btnCreate'), $('#btnResume')];
  btns.forEach((b) => { b.disabled = true; });
  $('#btnCreate').textContent = 'Creando sala…';
  const t = createTransport(app.mode);
  wire(t);
  try {
    const { code } = resume ? await t.resumeHost(resume) : await t.createRoom();
    Object.assign(app, { transport: t, role: 'host', code });
    $('#roomCode').textContent = code;
    $('#shareLink').value = shareUrl(code);
    document.title = `Sala ${code} · ¡Yo ya estoy!`;
    show('host');
    onStatus({ connected: true });
    render();
  } catch (err) {
    t.close();
    if (resume) { savedHost.clear(app.mode); refreshResume(); }
    toast(err.message, 'error');
  } finally {
    btns.forEach((b) => { b.disabled = false; });
    $('#btnCreate').textContent = 'Crear sala';
  }
}

async function startPlayer(code, name) {
  code = code.trim().toUpperCase();
  name = name.trim();
  if (!code || !name) return toast('Escribe tu nombre y el código de sala.', 'error');
  const btn = $('#btnJoin');
  btn.disabled = true;
  btn.textContent = 'Conectando…';
  const t = createTransport(app.mode);
  wire(t);
  try {
    const r = await t.join(code, clientId(), name);
    Object.assign(app, { transport: t, role: 'player', code, me: r.playerId, name: r.name });
    session.set('yye:player', { code, name: r.name });
    $('#playerName').textContent = r.name;
    $('#playerRoom').textContent = code;
    document.title = `${r.name} · Sala ${code}`;
    show('player');
    onStatus({ connected: true });
    $('#btnNotif').hidden = !('Notification' in window) || Notification.permission !== 'default';
    render();
  } catch (err) {
    t.close();
    session.del('yye:player');
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar a la sala';
  }
}

function leave() {
  const msg = app.role === 'host'
    ? '¿Cerrar la sala? Los participantes se desconectarán y se borrará la sala guardada en este equipo.'
    : '¿Salir de la sala?';
  if (!confirm(msg)) return;
  if (app.role === 'host') savedHost.clear(app.mode);
  session.del('yye:player');
  app.transport?.close();
  location.href = location.pathname + (new URLSearchParams(location.search).has('modo') ? `?modo=${app.mode}` : '');
}

function refreshResume() {
  const saved = savedHost.get(app.mode);
  $('#resumeBox').hidden = !saved?.code;
  if (saved?.code) $('#btnResume').textContent = `Reanudar sala ${saved.code}`;
}

// ------------------------------------------------------------------ Render
async function requestSync() {
  if (app.syncing || !app.transport) return;
  app.syncing = true;
  try {
    const full = await app.transport.action('sync');
    app.snap = mergeState(null, full).view;
    app.offset = full.serverNow - Date.now();
    render();
  } catch { /* se reintenta con el siguiente estado */ } finally {
    app.syncing = false;
  }
}

const lastRound = () => app.snap?.live ?? null;
const openRound = () => (lastRound()?.status === 'open' ? lastRound() : null);

function render() {
  if (!app.snap) return;
  if (app.role === 'host') renderHost();
  else if (app.role === 'player') renderPlayer();
}

function validTag(v) {
  if (v === true) return '<span class="tag ok">✓ Correcta</span>';
  if (v === false) return '<span class="tag bad">✗ Incorrecta</span>';
  return '<span class="tag pending">Sin validar</span>';
}

function logHtml(round, { showAnswers }) {
  if (!round) return '<p class="empty">Aún no hay rondas. Cuando el moderador inicie una, aquí verás quién termina primero.</p>';
  if (!round.presses.length) {
    return `<p class="empty">${round.status === 'open' ? 'Nadie ha presionado todavía…' : 'Nadie presionó en esta ronda.'}</p>`;
  }
  const rows = round.presses.map((p) => {
    const cls = [p.playerId === app.me ? 'me' : '', p.playerId === round.winnerId ? 'winner' : ''].join(' ');
    return `<tr class="${cls}">
      <td class="num">${p.position === 1 ? '🥇' : p.position}</td>
      <td>${esc(p.name)}${p.playerId === round.winnerId ? ' 🏆' : ''}</td>
      <td class="num">${fmt(p.elapsedMs)}</td>
      ${showAnswers ? `<td class="answer">${p.answer ? esc(p.answer) : '<span class="muted">—</span>'}</td>` : ''}
      <td>${validTag(p.valid)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th class="num">#</th><th>Nombre</th><th class="num">Tiempo</th>${showAnswers ? '<th>Respuesta</th>' : ''}<th>Validación</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function rankingHtml(snap) {
  const rows = (snap.ranking ?? []).filter((r) => r.presses > 0 || r.connected);
  if (!rows.length) return '<p class="empty">La clasificación aparecerá cuando haya participantes.</p>';
  const medal = (r) => (r.points > 0 && r.rank <= 3 ? `<span class="medal">${['🥇', '🥈', '🥉'][r.rank - 1]}</span>` : r.rank);
  const body = rows.map((r) => `<tr class="${r.playerId === app.me ? 'me' : ''}">
      <td class="num">${medal(r)}</td>
      <td>${esc(r.name)}${r.connected ? '' : ' <span class="muted">(fuera)</span>'}</td>
      <td class="num"><strong>${r.points}</strong></td>
      <td class="num">${r.wins}</td>
      <td class="num">${r.correct}/${r.presses}</td>
      <td class="num">${r.firsts}</td>
      <td class="num">${fmt(r.avgCorrectMs)}</td>
      <td class="num">${fmt(r.bestMs)}</td>
      <td class="num">${fmt(r.avgMs)}</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th class="num">Lugar</th><th>Nombre</th><th class="num">Puntos</th><th class="num" title="Rondas ganadas">Ganadas</th>
      <th class="num" title="Respuestas correctas / participaciones">Correctas</th>
      <th class="num" title="Veces que presionó primero">1.º en presionar</th>
      <th class="num" title="Tiempo promedio de sus respuestas correctas">Prom. correctas</th>
      <th class="num" title="Su respuesta correcta más rápida">Mejor</th>
      <th class="num" title="Tiempo promedio de todas sus participaciones">Prom. general</th>
    </tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted small-text">Ganar la ronda (primera respuesta correcta): ${POINTS_WINNER} pts · Otra respuesta correcta: ${POINTS_CORRECT} pt. Empates: más rondas ganadas, más correctas, menor tiempo promedio.</p>`;
}

function summaryHtml(snap) {
  const rows = [];
  const summaries = [...(snap.history ?? [])];
  if (snap.live) summaries[snap.live.number - 1] = summarizeRound(snap.live);
  for (let i = 0; i < snap.maxRounds; i++) {
    const r = summaries[i];
    if (!r) {
      rows.push(`<tr class="future"><td class="num">${i + 1}</td><td colspan="5">—</td></tr>`);
      continue;
    }
    const { first, winner } = r;
    const status = r.status === 'open'
      ? '<span class="tag open">En curso</span>'
      : r.pending && r.count ? '<span class="tag pending">Por validar</span>' : '<span class="tag ok">Cerrada</span>';
    rows.push(`<tr>
      <td class="num">${r.number}</td>
      <td class="answer">${r.question ? esc(r.question) : '<span class="muted">Sin descripción</span>'}</td>
      <td>${first ? `${esc(first.name)} <span class="muted">${fmt(first.elapsedMs)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${winner ? `🏆 ${esc(winner.name)} <span class="muted">${fmt(winner.elapsedMs)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="num">${r.count}</td>
      <td>${status}</td>
    </tr>`);
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th class="num">Ronda</th><th>Actividad</th><th>Primero en presionar</th><th>Ganador (correcta)</th><th class="num">Particip.</th><th>Estado</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function renderHost() {
  const snap = app.snap;
  const last = lastRound();
  const open = openRound();
  const played = snap.roundsPlayed;
  const players = snap.players ?? [];

  const connected = players.filter((p) => p.connected);
  $('#playerCount').textContent = connected.length;
  $('#playerList').innerHTML = players.length
    ? players.map((p) => `<li class="${p.connected ? '' : 'off'}"><span class="dot"></span>${esc(p.name)}</li>`).join('')
    : '<li class="off">Esperando participantes…</li>';

  let title;
  if (open) title = `Ronda ${open.number} de ${snap.maxRounds} · en curso`;
  else if (snap.finished) title = `🏁 Juego terminado · ${snap.maxRounds} rondas`;
  else if (last) title = `Ronda ${last.number} cerrada · sigue la ${played + 1} de ${snap.maxRounds}`;
  else title = `Ronda 1 de ${snap.maxRounds} · lista para iniciar`;
  $('#hostRoundTitle').textContent = title;
  $('#hostProgress').style.width = `${(played / snap.maxRounds) * 100}%`;

  $('#btnStart').disabled = Boolean(open) || played >= snap.maxRounds;
  $('#btnStart').textContent = played >= snap.maxRounds && !open ? '🏁 10 rondas completadas' : `▶ Iniciar ronda ${open ? open.number : played + 1}`;
  $('#btnClose').disabled = !open;
  $('#btnValidate').disabled = !last;
  $('#btnResetRound').disabled = !last;
  $('#btnResetGame').disabled = !played;
  $('#btnCsv').disabled = !played;
  $('#questionInput').disabled = Boolean(open) || played >= snap.maxRounds;

  const shown = open ?? last;
  $('#hostLogRound').textContent = shown ? `· ronda ${shown.number}` : '';
  $('#hostLog').innerHTML = logHtml(shown, { showAnswers: true });
  $('#hostRanking').innerHTML = rankingHtml(snap);
  $('#hostSummary').innerHTML = summaryHtml(snap);

  if ($('#validateDialog').open) renderValidate();
}

function renderPlayer() {
  const snap = app.snap;
  const last = lastRound();
  const open = openRound();
  const mine = open?.presses.find((p) => p.playerId === app.me)
    ?? (open && app.myPress?.round === open.number ? app.myPress : null);
  const btn = $('#bigButton');

  let title;
  if (open) title = `Ronda ${open.number} de ${snap.maxRounds}`;
  else if (snap.finished) title = '🏁 ¡Juego terminado!';
  else if (last) title = `Ronda ${last.number} cerrada`;
  else title = 'Esperando al moderador…';
  $('#playerRoundTitle').textContent = title;

  const q = (open ?? last)?.question;
  $('#playerQuestion').hidden = !q;
  $('#playerQuestion').textContent = q ?? '';

  btn.disabled = !open || Boolean(mine);
  btn.classList.toggle('done', Boolean(mine));
  btn.classList.toggle('ready', Boolean(open) && !mine);
  btn.innerHTML = mine ? 'Yo Ya<br>Estoy<br>! ! !' : '¿Cómo<br>Vamos?';
  $('#answerInput').disabled = !open || Boolean(mine);
  if (!open) $('#answerInput').value = '';

  const status = $('#playerStatus');
  status.classList.remove('ok');
  if (mine) {
    status.classList.add('ok');
    status.textContent = `Registrado: lugar #${mine.position} · ${fmt(mine.elapsedMs)}`;
  } else if (open) {
    status.textContent = 'Presiona el botón (o Enter) en cuanto termines.';
  } else if (last) {
    const myLast = last.presses.find((p) => p.playerId === app.me);
    const winner = last.presses.find((p) => p.playerId === last.winnerId);
    const parts = [];
    if (myLast) parts.push(`Tu resultado: #${myLast.position} · ${fmt(myLast.elapsedMs)} · ${myLast.valid === true ? '✓ correcta' : myLast.valid === false ? '✗ incorrecta' : 'por validar'}`);
    if (winner) parts.push(`Ganó ${winner.name}`);
    if (!snap.finished) parts.push('Espera la siguiente ronda.');
    status.textContent = parts.join(' · ');
  } else {
    status.textContent = 'Cuando el moderador inicie la ronda, el botón se activará.';
  }

  const shown = open ?? last;
  $('#playerLogRound').textContent = shown ? `· ronda ${shown.number}` : '';
  $('#playerLog').innerHTML = logHtml(shown, { showAnswers: shown?.status === 'closed' });
  $('#playerRanking').innerHTML = rankingHtml(snap);
  $('#playerSummary').innerHTML = summaryHtml(snap);
}

// ------------------------------------------------------------------ Ventana de validación
function openValidate(roundNumber) {
  const last = lastRound();
  if (!last) return;
  showValidateRound(roundNumber ?? last.number);
  if (!$('#validateDialog').open) $('#validateDialog').showModal();
}

async function showValidateRound(number) {
  app.vdRound = number;
  // La ronda actual ya está en pantalla; las anteriores se piden completas al moderador/servidor.
  app.vdData = number === lastRound()?.number ? null : await act('round', { number });
  renderValidate();
}

function renderValidate() {
  const snap = app.snap;
  const live = lastRound();
  const round = app.vdRound === live?.number || !app.vdData ? live : app.vdData;
  if (!round) return;
  app.vdRound = round.number;
  $('#vdRound').innerHTML = Array.from({ length: snap.roundsPlayed }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${n === round.number ? 'selected' : ''}>${n}${n === live?.number && live.status === 'open' ? ' (en curso)' : ''}</option>`)
    .join('');
  $('#vdQuestion').hidden = !round.question;
  $('#vdQuestion').textContent = round.question;
  if (!round.presses.length) {
    $('#vdList').innerHTML = '<p class="empty">Nadie presionó en esta ronda.</p>';
    return;
  }
  $('#vdList').innerHTML = round.presses.map((p) => `
    <div class="vd-item">
      <div class="vd-pos">#${p.position}</div>
      <div class="vd-who">
        <strong>${esc(p.name)}${p.playerId === round.winnerId ? ' 🏆' : ''} <span class="muted">${fmt(p.elapsedMs)}</span></strong>
        <span class="answer">${p.answer ? `“${esc(p.answer)}”` : 'Sin respuesta escrita'}</span>
      </div>
      <div class="vd-btns" data-player="${esc(p.playerId)}">
        <button type="button" class="yes" data-valid="1" aria-pressed="${p.valid === true}">✓ Correcta</button>
        <button type="button" class="no" data-valid="0" aria-pressed="${p.valid === false}">✗ Incorrecta</button>
        <button type="button" class="clear" data-valid="" aria-pressed="${p.valid === null}" title="Quitar validación">–</button>
      </div>
    </div>`).join('');
}

// ------------------------------------------------------------------ Cronómetros
function tick() {
  const last = lastRound();
  let ms = 0;
  let running = false;
  if (last) {
    running = last.status === 'open';
    ms = running ? Date.now() + app.offset - last.startedAt : (last.endedAt ?? last.startedAt) - last.startedAt;
  }
  for (const el of document.querySelectorAll('[data-timer]')) {
    el.textContent = fmt(ms);
    el.classList.toggle('running', running);
  }
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ Acciones
async function act(action, payload) {
  try {
    return await app.transport.action(action, payload);
  } catch (err) {
    toast(err.message, 'error');
    render();
    return undefined;
  }
}

async function pressBuzzer() {
  const btn = $('#bigButton');
  if (btn.disabled) return;
  btn.disabled = true;
  unlockAudio();
  const round = openRound()?.number;
  const result = await act('press', { answer: $('#answerInput').value });
  if (result) {
    app.myPress = { ...result, round };
    navigator.vibrate?.(60);
    render();
  }
}

async function downloadCSV() {
  const rounds = await act('export');
  if (!rounds) return;
  const blob = new Blob([roundsToCSV(rounds)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bitacora-sala-${app.code}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bindEvents() {
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    unlockAudio();
    startPlayer($('#joinCode').value, $('#joinName').value);
  });
  $('#btnCreate').addEventListener('click', () => { unlockAudio(); startHost(null); });
  $('#btnResume').addEventListener('click', () => { unlockAudio(); startHost(savedHost.get(app.mode)); });
  $('#btnLeave').addEventListener('click', leave);

  // Moderador
  $('#btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#shareLink').value); toast('Enlace copiado', 'ok'); } catch {
      $('#shareLink').select(); toast('Selecciona y copia el enlace manualmente');
    }
  });
  $('#btnStart').addEventListener('click', async () => {
    const r = await act('start', { question: $('#questionInput').value });
    if (r) $('#questionInput').value = '';
  });
  $('#questionInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#btnStart').disabled) $('#btnStart').click(); });
  $('#btnClose').addEventListener('click', async () => {
    const r = await act('close');
    if (r && lastRound()?.presses.length) openValidate(r.number);
  });
  $('#btnValidate').addEventListener('click', () => openValidate());
  $('#btnResetRound').addEventListener('click', () => {
    const n = lastRound()?.number;
    if (confirm(`¿Reiniciar la ronda ${n}? Se borran sus registros y el cronómetro vuelve a cero para todos.`)) act('resetRound');
  });
  $('#btnResetGame').addEventListener('click', () => {
    if (confirm('¿Reiniciar todo el juego? Se borran todas las rondas, la bitácora y la clasificación. Los participantes siguen conectados.')) act('resetGame');
  });
  $('#btnCsv').addEventListener('click', downloadCSV);

  // Ventana de validación
  $('#vdRound').addEventListener('change', (e) => showValidateRound(Number(e.target.value)));
  $('#vdList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-valid]');
    if (!b) return;
    const playerId = b.parentElement.dataset.player;
    const valid = b.dataset.valid === '1' ? true : b.dataset.valid === '0' ? false : null;
    const number = app.vdRound;
    act('validate', { round: number, playerId, valid }).then((round) => {
      if (round && app.vdRound === number && number !== lastRound()?.number) { app.vdData = round; renderValidate(); }
    });
  });
  $('#vdClose').addEventListener('click', () => $('#validateDialog').close());

  // Participante
  $('#bigButton').addEventListener('click', pressBuzzer);
  $('#answerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pressBuzzer(); } });
  document.addEventListener('keydown', (e) => {
    if (app.role !== 'player' || e.repeat || e.target.matches('input, select, textarea, button')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pressBuzzer(); }
  });
  $('#btnNotif').addEventListener('click', async () => {
    const r = await Notification.requestPermission();
    $('#btnNotif').hidden = true;
    toast(r === 'granted' ? 'Notificaciones activadas' : 'Notificaciones no permitidas', r === 'granted' ? 'ok' : '');
  });
}

async function init() {
  bindEvents();
  requestAnimationFrame(tick);
  app.mode = await detectMode();
  const badge = $('#modeBadge');
  badge.hidden = false;
  badge.textContent = app.mode === 'servidor' ? 'Modo servidor' : 'Modo P2P';
  badge.title = app.mode === 'servidor'
    ? 'Conectado al servidor Node.js (Socket.IO).'
    : 'Sin servidor propio: el navegador del moderador guarda la sala y los participantes se conectan a él (PeerJS/WebRTC). Mantén abierta la página del moderador.';
  refreshResume();

  const params = new URLSearchParams(location.search);
  const sala = params.get('sala')?.toUpperCase();
  if (sala) $('#joinCode').value = sala;

  const saved = session.get('yye:player');
  if (saved && (!sala || sala === saved.code)) {
    $('#joinCode').value = saved.code;
    $('#joinName').value = saved.name;
    startPlayer(saved.code, saved.name);
  } else if (sala) {
    $('#joinName').focus();
  }
}

init();
