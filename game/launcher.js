import { joinMultiplayerRoom } from '../multiplayer/session.js';
import {
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  createInviteCode,
  inviteProof,
  matchRoom,
  normalizeInviteCode,
  privateRoom,
  quickplayRoom,
  rankHosts,
  seedForScope,
  shortPeer,
  verifyInviteProof,
} from '../multiplayer/protocol.js';

const byId = (id) => document.getElementById(id);
const launcher = byId('launcher');
const pages = [...document.querySelectorAll('[data-launch-page]')];
const lobbyNames = new Map();
let session = null;
let lobbyMode = null;
let inviteCode = '';
let launchStarted = false;
let quickTimer = null;
let voiceActive = false;
let voiceMuted = false;
let voicePlaybackBlocked = false;
let voicePending = false;
let joinGeneration = 0;
let lobbyOff = [];
const readyPeers = new Set();
const readyEchoed = new Set();
const hostScores = new Map();
let ownCapacity = { score: 0, outMbps: 0, rttMs: 0 };
let pendingMatch = null;
let committing = false;

function savedName() {
  try { return localStorage.getItem('charon-player-name') || ''; }
  catch { return ''; }
}

function rememberName(name) {
  try { localStorage.setItem('charon-player-name', name); }
  catch { /* opaque-origin dwapps intentionally have no durable storage */ }
}

function setHash(route) {
  try { history.replaceState(null, '', `#${route}`); }
  catch { /* sandbox may not expose history mutation */ }
}

function showPage(name) {
  for (const page of pages) page.hidden = page.dataset.launchPage !== name;
  setHash(name === 'menu' ? 'home' : name);
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  const page = document.querySelector(`[data-launch-page="${name}"]`);
  const focus = page?.querySelector('h1') ?? page?.querySelector('input, button');
  if (focus?.matches?.('h1')) focus.setAttribute('tabindex', '-1');
  focus?.focus?.({ preventScroll: true });
}

function displayError(message) {
  const status = byId('lobby-status');
  status.textContent = message;
  status.dataset.tone = 'error';
  const inline = byId('multiplayer-error');
  if (inline && document.querySelector('[data-launch-page="lobby"]')?.hidden) {
    inline.textContent = message;
    inline.hidden = false;
    byId('invite-code')?.setAttribute('aria-invalid', 'true');
    byId('invite-code')?.focus();
  }
}

function updateVoice(status = {}) {
  voiceActive = !!status.active;
  voiceMuted = !!status.muted;
  voicePlaybackBlocked = !!status.playbackBlocked;
  byId('voice-state').textContent = !voiceActive ? 'microphone off'
    : voicePlaybackBlocked ? 'speaker playback needs a click'
      : voiceMuted ? 'muted · speakers live' : 'microphone + speakers live';
  byId('voice-toggle').textContent = !voiceActive ? 'ENABLE' : voicePlaybackBlocked ? 'ENABLE AUDIO' : voiceMuted ? 'UNMUTE' : 'MUTE';
}

async function toggleVoice() {
  if (!session || voicePending) return;
  voicePending = true;
  byId('voice-toggle').disabled = true;
  try {
    const status = voicePlaybackBlocked
      ? await session.resumeVoicePlayback()
      : voiceActive ? await session.setVoiceMuted(!voiceMuted)
      : await session.startVoice({ startMuted: false });
    updateVoice(status);
  } catch (error) {
    updateVoice({ active: false, muted: false });
    byId('voice-state').textContent = error.message || 'microphone permission denied';
  } finally {
    voicePending = false;
    byId('voice-toggle').disabled = false;
  }
}

function playerName() {
  const value = byId('player-name').value.trim().slice(0, 24);
  const name = value || `ODST-${Math.floor(Math.random() * 900 + 100)}`;
  byId('player-name').value = name;
  rememberName(name);
  return name;
}

function currentGroup() {
  if (!session) return [];
  // Gossip may replay a signed READY from a peer whose rendezvous socket has
  // already vanished. Matchmaking counts only identities still present in the
  // live room mesh, so a ghost can never launch or occupy a fireteam slot.
  const online = new Set(session.roster().map((peer) => peer.did));
  const all = [...new Set([session.did, ...readyPeers])].filter((did) => online.has(did)).sort();
  if (lobbyMode !== 'quick') return all.slice(0, MAX_PLAYERS);
  const ownIndex = all.indexOf(session.did);
  const groupStart = Math.max(0, Math.floor(ownIndex / MAX_PLAYERS) * MAX_PLAYERS);
  return all.slice(groupStart, groupStart + MAX_PLAYERS);
}

function hostOrder(members = currentGroup()) {
  return rankHosts(members, hostScores);
}

function isHost() {
  return hostOrder()[0] === session?.did;
}

function renderRoster() {
  if (!session) return;
  const groupIds = currentGroup();
  const group = new Set(groupIds);
  if (!launchStarted) session.setVoicePeers(groupIds);
  const roster = byId('lobby-roster');
  roster.textContent = '';
  for (const did of groupIds) {
    const row = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    const identity = document.createElement('span');
    identity.className = 'roster-name';
    identity.textContent = did === session.did
      ? `${session.name} (you)`
      : (lobbyNames.get(did) || session.roster().find((peer) => peer.did === did)?.name || shortPeer(did));
    const role = document.createElement('span');
    role.className = 'roster-role';
    role.textContent = did === hostOrder(groupIds)[0] ? 'authority' : 'ready';
    row.append(dot, identity, role);
    roster.appendChild(row);
  }
  const count = currentGroup().length;
  byId('lobby-count').textContent = `${count} / ${MAX_PLAYERS}`;
  byId('lobby-start').hidden = !isHost() || lobbyMode === 'quick';
  byId('lobby-start').disabled = count < 1;
  byId('lobby-status').dataset.tone = 'ok';
  if (pendingMatch) {
    byId('lobby-status').textContent = committing
      ? 'Fireteam confirmed. Entering the match room…'
      : `Confirming fireteam · ${pendingMatch.acknowledgements.size} / ${pendingMatch.payload.members.length}`;
    return;
  }
  if (lobbyMode === 'quick') {
    byId('lobby-status').textContent = count >= 2
      ? 'Fireteam found. Launching in a moment…'
      : 'Searching the public queue for another survivor…';
    scheduleQuickStart();
  } else {
    byId('lobby-status').textContent = isHost()
      ? 'Room secured. Share the code, then deploy when your fireteam is ready.'
      : 'Connected. Waiting for the host to deploy the fireteam.';
  }
}

async function broadcastLobby(kind, extra = {}) {
  if (!session) return;
  const proof = lobbyMode === 'quick' ? null : await inviteProof(inviteCode, session.did);
  await session.publish('lobby', {
    v: PROTOCOL_VERSION,
    kind,
    from: session.did,
    name: session.name,
    ...(proof ? { inviteProof: proof } : {}),
    ...extra,
  });
}

function scheduleQuickStart() {
  if (quickTimer || !isHost() || currentGroup().length < 2 || launchStarted) return;
  quickTimer = setTimeout(() => {
    quickTimer = null;
    if (isHost() && currentGroup().length >= 2) startMatch();
  }, 3200);
}

async function startMatch() {
  if (!session || launchStarted || pendingMatch || !isHost()) return;
  const members = currentGroup();
  if (!members.length) return;
  const scope = `match-${createInviteCode()}`;
  const hosts = hostOrder(members);
  const payload = { members, hosts, scope, seed: seedForScope(scope), host: hosts[0] };
  pendingMatch = { payload, acknowledgements: new Set([session.did]) };
  byId('lobby-status').textContent = 'Confirming the fireteam…';
  for (let attempt = 0; attempt < 6 && pendingMatch && !launchStarted; attempt++) {
    await broadcastLobby('proposal', payload).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (pendingMatch && members.every((did) => pendingMatch.acknowledgements.has(did))) {
      await commitMatch();
      return;
    }
  }
  if (!launchStarted) {
    pendingMatch = null;
    displayError('A fireteam member did not confirm. Check the connection and deploy again.');
  }
}

async function commitMatch() {
  if (!pendingMatch || committing || launchStarted) return;
  committing = true;
  const payload = pendingMatch.payload;
  await broadcastLobby('commit', payload);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await broadcastLobby('commit', payload).catch(() => {});
  await deploy(payload);
}

async function deploy({ members, hosts, scope, seed, host }) {
  if (launchStarted || !session || !members.includes(session.did)) return;
  launchStarted = true;
  clearTimeout(quickTimer);
  quickTimer = null;
  for (const off of lobbyOff.splice(0)) off();
  const lobbySession = session;
  const name = lobbySession.name;
  const identity = lobbySession.identity;
  const resumeVoice = voiceActive;
  const resumeMuted = voiceMuted;
  lobbySession.setVoicePeers([]);
  await lobbySession.close();
  updateVoice({ active: false, muted: false });
  try {
    session = await joinMultiplayerRoom({ roomId: matchRoom(scope), name, identity });
    session.setScope(scope);
    session.setVoicePeers(members);
    await session.refreshPresence();
    if (resumeVoice) {
      try { updateVoice(await session.startVoice({ startMuted: resumeMuted })); }
      catch { updateVoice({ active: false, muted: false }); }
    }
  } catch (error) {
    session = null;
    launchStarted = false;
    committing = false;
    showPage('multiplayer');
    displayError(`Could not enter the match room: ${error.message}`);
    return;
  }
  await launchGame({
    mode: 'multiplayer',
    session,
    name,
    roomId: session.roomId,
    members,
    scope,
    seed,
    host: host || members[0],
    hostOrder: Array.isArray(hosts) ? hosts : [host || members[0], ...members.filter((did) => did !== host)],
  });
}

function validMatchPayload(packet) {
  if (!session || !Array.isArray(packet?.members)) return null;
  const members = [...new Set(packet.members.filter((did) => typeof did === 'string' && did.length <= 160))].sort();
  const expected = currentGroup();
  const valid = members.length > 0 && members.length <= MAX_PLAYERS
    && members.length === expected.length
    && members.every((did, index) => did === expected[index])
    && Array.isArray(packet.hosts)
    && packet.hosts.length === members.length
    && packet.hosts.every((did, index) => did === hostOrder(members)[index])
    && packet.from === packet.hosts[0]
    && packet.host === packet.hosts[0]
    && /^match-[a-z0-9]{12,48}$/.test(packet.scope)
    && packet.seed === seedForScope(packet.scope);
  return valid ? { members, hosts: [...packet.hosts], scope: packet.scope, seed: packet.seed, host: packet.host } : null;
}

function setJoinButtons(disabled) {
  for (const id of ['quick-play', 'host-private', 'join-private']) byId(id).disabled = disabled;
}

async function joinLobby(mode) {
  const generation = ++joinGeneration;
  setJoinButtons(true);
  for (const off of lobbyOff.splice(0)) off();
  if (session) await session.close();
  session = null;
  lobbyMode = mode;
  launchStarted = false;
  committing = false;
  pendingMatch = null;
  readyPeers.clear();
  readyEchoed.clear();
  hostScores.clear();
  lobbyNames.clear();
  const name = playerName();
  byId('multiplayer-error').hidden = true;
  byId('invite-code').removeAttribute('aria-invalid');
  let roomId;
  try {
    if (mode === 'quick') {
      roomId = quickplayRoom();
      inviteCode = '';
    } else if (mode === 'host') {
      inviteCode = createInviteCode();
      roomId = await privateRoom(inviteCode);
    } else {
      inviteCode = normalizeInviteCode(byId('invite-code').value);
      roomId = await privateRoom(inviteCode);
    }
  } catch (error) {
    displayError(error.message);
    return;
  }

  showPage('lobby');
  byId('lobby-title').textContent = mode === 'quick' ? 'QUICK MATCH' : 'PRIVATE FIRETEAM';
  byId('invite-panel').hidden = mode === 'quick';
  byId('invite-value').value = inviteCode;
  byId('lobby-roster').textContent = '';
  byId('lobby-status').dataset.tone = '';
  byId('lobby-status').textContent = 'Opening a peer-to-peer room…';
  try {
    const joined = await joinMultiplayerRoom({ roomId, name });
    if (generation !== joinGeneration) {
      await joined.close();
      return;
    }
    session = joined;
    session.setScope(roomId);
    ownCapacity = await session.capacity().catch(() => ({ score: 0, outMbps: 0, rttMs: 0 }));
    ownCapacity.score = Math.round(Math.max(0, Math.min(1_000, Number(ownCapacity.score) || 0)));
    ownCapacity.outMbps = Math.max(0, Math.round(Number(ownCapacity.outMbps) || 0));
    ownCapacity.rttMs = Math.max(0, Math.round(Number(ownCapacity.rttMs) || 0));
    hostScores.set(session.did, ownCapacity);
    byId('transport-label').textContent = session.transport === 'peerd'
      ? 'PEERD BASE MESH'
      : 'WEBRTC · WEB BUNDLE';
    const offTopic = await session.subscribe('lobby', (message) => {
      void (async () => {
        const packet = message?.data;
        if (!packet || packet.v !== PROTOCOL_VERSION || message?.from !== packet.from || packet.from === session.did) return;
        if (lobbyMode !== 'quick'
          && !(await verifyInviteProof(inviteCode, packet.from, packet.inviteProof))) return;
        if (packet.name) lobbyNames.set(message.from, String(packet.name).slice(0, 24));
        if (packet.kind === 'ready') {
          readyPeers.add(packet.from);
          hostScores.set(packet.from, {
            score: Math.max(0, Math.min(1_000, Number(packet.capacity?.score) || 0)),
            outMbps: Math.max(0, Number(packet.capacity?.outMbps) || 0),
            rttMs: Math.max(0, Number(packet.capacity?.rttMs) || 0),
          });
          if (!readyEchoed.has(packet.from)) {
            readyEchoed.add(packet.from);
            broadcastLobby('ready', { capacity: ownCapacity }).catch(() => {});
          }
        } else if (packet.kind === 'proposal') {
          const payload = validMatchPayload(packet);
          if (payload) {
            pendingMatch = { payload, acknowledgements: new Set() };
            broadcastLobby('ack', { scope: payload.scope, members: payload.members }).catch(() => {});
          }
        } else if (packet.kind === 'ack' && pendingMatch && isHost()
          && packet.scope === pendingMatch.payload.scope
          && Array.isArray(packet.members)
          && packet.members.join('\u0000') === pendingMatch.payload.members.join('\u0000')
          && pendingMatch.payload.members.includes(packet.from)) {
          pendingMatch.acknowledgements.add(packet.from);
          if (pendingMatch.payload.members.every((did) => pendingMatch.acknowledgements.has(did))) {
            commitMatch().catch((error) => displayError(error.message));
          }
        } else if (packet.kind === 'commit' && pendingMatch) {
          const payload = validMatchPayload(packet);
          if (payload && payload.scope === pendingMatch.payload.scope) deploy(payload);
        }
        renderRoster();
      })().catch(() => {});
    });
    lobbyOff.push(
      offTopic,
      session.on('roster', renderRoster),
      session.on('voice', updateVoice),
      session.on('peer-leave', (did) => {
        readyPeers.delete(did);
        readyEchoed.delete(did);
        hostScores.delete(did);
        if (pendingMatch?.payload.members.includes(did)) {
          pendingMatch = null;
          committing = false;
          displayError('A fireteam member disconnected. Match confirmation was cancelled.');
        }
        renderRoster();
      }),
    );
    await session.refreshPresence();
    await broadcastLobby('ready', { capacity: ownCapacity });
    renderRoster();
  } catch (error) {
    if (generation === joinGeneration) {
      session = null;
      displayError(error.message || 'Could not open the multiplayer room.');
    }
  } finally {
    if (generation === joinGeneration) setJoinButtons(false);
  }
}

async function launchGame(config) {
  globalThis.__charonLaunch = config;
  document.body.classList.remove('launcher-active');
  launcher.hidden = true;
  byId('intro').style.display = '';
  byId('overlay').style.display = '';
  try {
    await import('./main.js?v=1');
  } catch (error) {
    launcher.hidden = false;
    document.body.classList.add('launcher-active');
    showPage('menu');
    const notice = byId('menu-notice');
    notice.textContent = `Could not start Charon: ${error.message}`;
    notice.hidden = false;
    throw error;
  }
}

async function leaveLobby() {
  joinGeneration += 1;
  setJoinButtons(false);
  clearTimeout(quickTimer);
  quickTimer = null;
  for (const off of lobbyOff.splice(0)) off();
  if (session) await session.close();
  session = null;
  updateVoice({ active: false, muted: false });
  lobbyNames.clear();
  readyPeers.clear();
  readyEchoed.clear();
  hostScores.clear();
  pendingMatch = null;
  committing = false;
  showPage('multiplayer');
}

for (const button of document.querySelectorAll('[data-open-page]')) {
  button.addEventListener('click', async () => {
    const target = button.dataset.openPage;
    if (session && !launchStarted && !document.querySelector('[data-launch-page="lobby"]')?.hidden) {
      await leaveLobby();
    }
    showPage(target);
  });
}
for (const tab of document.querySelectorAll('[data-doc-tab]')) {
  tab.addEventListener('click', () => {
    for (const candidate of document.querySelectorAll('[data-doc-tab]')) {
      candidate.setAttribute('aria-selected', String(candidate === tab));
      candidate.tabIndex = candidate === tab ? 0 : -1;
    }
    for (const panel of document.querySelectorAll('[data-doc-panel]')) {
      panel.hidden = panel.dataset.docPanel !== tab.dataset.docTab;
    }
    setHash(`docs/${tab.dataset.docTab}`);
  });
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight'
      && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-doc-tab]')];
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length].click();
    tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length].focus();
  });
}

byId('solo-play').addEventListener('click', () => launchGame({
  mode: 'solo',
  session: null,
  name: playerName(),
  seed: new URLSearchParams(location.search).get('seed') || undefined,
}));
byId('quick-play').addEventListener('click', () => joinLobby('quick'));
byId('host-private').addEventListener('click', () => joinLobby('host'));
byId('join-private').addEventListener('click', () => joinLobby('join'));
byId('lobby-start').addEventListener('click', startMatch);
byId('lobby-leave').addEventListener('click', leaveLobby);
byId('voice-toggle').addEventListener('click', toggleVoice);
byId('copy-invite').addEventListener('click', async () => {
  const input = byId('invite-value');
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    byId('copy-invite').textContent = 'COPIED';
  } catch {
    document.execCommand?.('copy');
    byId('copy-invite').textContent = 'SELECTED';
  }
  setTimeout(() => { byId('copy-invite').textContent = 'COPY CODE'; }, 1800);
});

byId('player-name').value = savedName();
const initialRoute = location.hash.replace(/^#/, '');
if (initialRoute === 'about') showPage('about');
else if (initialRoute.startsWith('docs')) {
  showPage('docs');
  const requested = initialRoute.split('/')[1];
  document.querySelector(`[data-doc-tab="${requested}"]`)?.click();
} else showPage('menu');
