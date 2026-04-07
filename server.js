const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bcrypt = require('bcryptjs');

const BOUNTY_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, 'bounties.json')))
  .map((b, idx) => {
    const parsedLevel = parseInt(b.level, 10);
    const level = [1, 2, 3].includes(parsedLevel) ? parsedLevel : ((idx % 3) + 1);
    return { ...b, level };
  });

const PLAYER_ELO = {
  'mousepuddles': 1005,
  'dragonlord freya': 1077,
  'jimmythicks': 1132,
  'moon182': 1151,
  '[swb]tralfamador': 1162,
  'burgoman2': 1190,
  'redneal11': 1256,
  'tdb.daniferdoser': 1266,
  'binny bong baron': 1287,
  'misc_leopard': 1329,
  'chpstkx': 1349,
  'lefty_sexton': 1409,
  'smarttguyy': 1517,
  'chipmunk': 1526,
  'dr. casă': 1550,
  'nik_may': 1587,
  'pl0tterghost': 1591,
  'leviii': 1603,
  'narutoshery': 1611,
  'superhero55': 1635,
  'vollkhornekeks': 1659,
  'supermonkeycar3000': 1681,
  'frozenflame': 1689,
  '[dd] hellooosh': 1708,
  'at41': 1735,
  'not sure': 1808,
  'gurastobbybufas vamiragodxo': 1852,
  'maxymczech': 2007,
  'dzedanik': 2068,
  'oladushek': 2104,
  'dghir | zarc': 2261,
  'clearlove': 2306,
  'matze': 2341,
  'togawa sakikoi': 2368,
  'wean dinchester': 2371,
  'lighty': 2396,
  'argh': 2451,
  'kongen_42': 2460,
  'rodrixs': 2468,
  'duduzhu': 2532,
  'os +| neozz': 2563,
};
const BOTTOM_CUTOFF_ELO = 1409;
const TOP_CUTOFF_ELO = 2104;

function normalizeName(name = '') {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCategoryForElo(elo) {
  if (elo <= BOTTOM_CUTOFF_ELO) return 'bottom';
  if (elo >= TOP_CUTOFF_ELO) return 'top';
  return 'middle';
}

// ── ADMIN AUTH ─────────────────────────────────────────────────────
// Set ADMIN_PASSWORD_HASH as a Railway environment variable.
// Generate it once by running:  node generate-hash.js
// The plain text password is never stored anywhere — only this hash.
// The fallback below is bcrypt of 'passwrang321' for local dev only.
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH
  || '$2a$12$u8G4rZmK3nXwP1vT9cL0OeQdF7bA2jE5hN6iM8kJ4sY3xW0pCuv2';

// ── RATE LIMITING ──────────────────────────────────────────────────
// 5 failed attempts within 60s triggers a 2 minute lockout.
const RATE_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS   = 5;
const LOCKOUT_MS     = 2 * 60 * 1000;
const loginAttempts  = {}; // { ip: { count, windowStart, lockedUntil } }

function checkRateLimit(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, windowStart: now, lockedUntil: null };
  const e = loginAttempts[ip];
  if (e.lockedUntil && now < e.lockedUntil) {
    const secsLeft = Math.ceil((e.lockedUntil - now) / 1000);
    return { allowed: false, secsLeft };
  }
  if (now - e.windowStart > RATE_WINDOW_MS) {
    e.count = 0; e.windowStart = now; e.lockedUntil = null;
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const e = loginAttempts[ip];
  e.count++;
  if (e.count >= MAX_ATTEMPTS) {
    e.lockedUntil = Date.now() + LOCKOUT_MS;
    e.count = 0; e.windowStart = Date.now();
  }
}

function clearAttempts(ip) { delete loginAttempts[ip]; }

// Clean up stale entries every 10 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(loginAttempts)) {
    const e = loginAttempts[ip];
    if ((!e.lockedUntil || now > e.lockedUntil) && now - e.windowStart > RATE_WINDOW_MS) {
      delete loginAttempts[ip];
    }
  }
}, 10 * 60 * 1000);

let globalDefaultRefreshLimit = 2;

// ── REDIS (Upstash REST API) ───────────────────────────────────────
// No extra npm package needed — uses the Upstash HTTP REST API with fetch.
// Set these in Railway environment variables:
//   UPSTASH_REDIS_REST_URL  = https://your-db.upstash.io
//   UPSTASH_REDIS_REST_TOKEN = your-token
// Falls back to in-memory only if not set (fine for local dev).
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);

if (USE_REDIS) {
  console.log('Redis persistence enabled via Upstash');
} else {
  console.log('No Redis env vars — running in-memory only (sessions lost on restart)');
}

async function redisCmd(...args) {
  if (!USE_REDIS) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data.result ?? null;
  } catch (e) {
    console.error('Redis error:', e.message);
    return null;
  }
}

// ── SESSION SERIALIZATION ──────────────────────────────────────────
function serializeSession(session) {
  return JSON.stringify({
    ...session,
    usedBountyIds: [...session.usedBountyIds],
    slots: { player1: null, player2: null, admin: null }, // socket IDs don't survive restart
  });
}

function deserializeSession(raw) {
  const obj = JSON.parse(raw);
  obj.usedBountyIds = new Set(obj.usedBountyIds || []);
  obj.slots = { player1: null, player2: null, admin: null };
  return obj;
}

async function persistSession(session) {
  await redisCmd('SET', 'session:' + session.id, serializeSession(session));
}

async function deleteSessionFromRedis(id) {
  await redisCmd('DEL', 'session:' + id);
}

async function persistSettings() {
  await redisCmd('SET', 'settings:global', JSON.stringify({ globalDefaultRefreshLimit }));
}

// ── IN-MEMORY STORE ────────────────────────────────────────────────
const sessions = {};

// ── STARTUP: RESTORE FROM REDIS ────────────────────────────────────
async function loadFromRedis() {
  if (!USE_REDIS) return;
  try {
    const settingsRaw = await redisCmd('GET', 'settings:global');
    if (settingsRaw) {
      const s = JSON.parse(settingsRaw);
      globalDefaultRefreshLimit = s.globalDefaultRefreshLimit ?? 2;
      console.log(`Restored global settings: refreshLimit=${globalDefaultRefreshLimit}`);
    }

    const keys = await redisCmd('KEYS', 'session:*');
    if (keys && keys.length) {
      for (const key of keys) {
        const raw = await redisCmd('GET', key);
        if (raw) {
          const session = deserializeSession(raw);
          sessions[session.id] = session;
        }
      }
      console.log(`Restored ${keys.length} sessions from Redis`);
    }
  } catch (e) {
    console.error('Error restoring from Redis:', e.message);
  }
}

// ── HELPERS ────────────────────────────────────────────────────────
function drawBounties(usedIds, count = 6, excludeIds = [], options = {}) {
  const { level3Only = false } = options;
  const available = BOUNTY_POOL.filter(b => !usedIds.has(b.id) && !excludeIds.includes(b.id));
  if (level3Only) {
    return available
      .filter(b => b.level === 3)
      .sort(() => Math.random() - 0.5)
      .slice(0, count);
  }
  const perTierTarget = Math.floor(count / 3);

  if (perTierTarget > 0) {
    const byTier = { 1: [], 2: [], 3: [] };
    available.forEach(b => {
      if (byTier[b.level]) byTier[b.level].push(b);
    });

    const balanced = [];
    for (const tier of [1, 2, 3]) {
      if (byTier[tier].length < perTierTarget) {
        return available.sort(() => Math.random() - 0.5).slice(0, count);
      }
      balanced.push(...byTier[tier].sort(() => Math.random() - 0.5).slice(0, perTierTarget));
    }

    const remainingSlots = count - balanced.length;
    if (remainingSlots > 0) {
      const pickedIds = new Set(balanced.map(b => b.id));
      const filler = available
        .filter(b => !pickedIds.has(b.id))
        .sort(() => Math.random() - 0.5)
        .slice(0, remainingSlots);
      balanced.push(...filler);
    }

    return balanced.sort(() => Math.random() - 0.5);
  }

  return available.sort(() => Math.random() - 0.5).slice(0, count);
}

function freshPlayer() {
  return {
    bounties: [],
    selectedBounty: null,
    lockedIn: false,
    confirmedReady: false,
    gameDoneReady: false,
    refreshesUsed: 0,       // total across the set
    roundRefreshesUsed: 0,  // resets each game
    poolSnapshots: [],      // [{ pool, label }] — one per initial deal + each refresh
  };
}

// Record a pool snapshot for a player at the start of a round or after a refresh
function addPoolSnapshot(player, label) {
  player.poolSnapshots.push({
    label,
    pool: player.bounties.map(b => ({ id: b.id, title: b.title, description: b.description, level: b.level })),
  });
}

function createSession() {
  const sessionId = uuidv4();
  const session = {
    id: sessionId,
    refreshLimit: globalDefaultRefreshLimit,
    slots: { player1: null, player2: null, admin: null },
    playerNames: { player1: null, player2: null },
    playerInfo: { player1: null, player2: null },
    gameNumber: 0,
    status: 'waiting',
    usedBountyIds: new Set(),
    players: { player1: freshPlayer(), player2: freshPlayer() },
    gameHistory: [],
    createdAt: Date.now(),
  };
  sessions[sessionId] = session;
  persistSession(session);
  return session;
}

function startFirstGame(session) {
  session.gameNumber = 1;
  session.status = 'bounty_phase';
  const p1Higher = session.playerInfo.player1?.isHigherCategory === true;
  const p2Higher = session.playerInfo.player2?.isHigherCategory === true;
  const p1 = drawBounties(session.usedBountyIds, 6, [], { level3Only: p1Higher });
  const p1Ids = p1.map(b => b.id);
  const p2 = drawBounties(session.usedBountyIds, 6, p1Ids, { level3Only: p2Higher });
  if (p1.length < 6 || p2.length < 6) {
    // Fallback safety in case level-3 pool is exhausted.
    const safeP1 = p1.length < 6 ? drawBounties(session.usedBountyIds, 6, []) : p1;
    const safeP1Ids = safeP1.map(b => b.id);
    const safeP2 = p2.length < 6 ? drawBounties(session.usedBountyIds, 6, safeP1Ids) : p2;
    session.players.player1.bounties = safeP1;
    session.players.player2.bounties = safeP2;
  } else {
    session.players.player1.bounties = p1;
    session.players.player2.bounties = p2;
  }
  addPoolSnapshot(session.players.player1, 'Initial Pool');
  addPoolSnapshot(session.players.player2, 'Initial Pool');
  persistSession(session);
  emitState(session);
}

function buildPlayerDetail(player, refreshLimit) {
  return {
    poolSnapshots: player.poolSnapshots,   // all snapshots for this round
    pick: player.selectedBounty,
    refreshesUsedThisRound: player.roundRefreshesUsed,
    refreshesRemainingAtLockIn: Math.max(0, refreshLimit - player.refreshesUsed),
  };
}

function advanceGame(session) {
  const p1 = session.players.player1;
  const p2 = session.players.player2;

  // Capture full round detail before resetting
  session.gameHistory.push({
    game: session.gameNumber,
    player1: p1.selectedBounty,
    player2: p2.selectedBounty,
    player1Detail: buildPlayerDetail(p1, session.refreshLimit),
    player2Detail: buildPlayerDetail(p2, session.refreshLimit),
  });

  if (p1.selectedBounty) session.usedBountyIds.add(p1.selectedBounty.id);
  if (p2.selectedBounty) session.usedBountyIds.add(p2.selectedBounty.id);

  session.gameNumber++;
  session.status = 'bounty_phase';

  // Pool shrinks — remove the used bounty
  p1.bounties = p1.bounties.filter(b => !session.usedBountyIds.has(b.id));
  p2.bounties = p2.bounties.filter(b => !session.usedBountyIds.has(b.id));

  // Reset per-game state
  p1.selectedBounty = null; p1.lockedIn = false; p1.confirmedReady = false;
  p1.gameDoneReady = false; p1.roundRefreshesUsed = 0; p1.poolSnapshots = [];
  p2.selectedBounty = null; p2.lockedIn = false; p2.confirmedReady = false;
  p2.gameDoneReady = false; p2.roundRefreshesUsed = 0; p2.poolSnapshots = [];

  // Snapshot the starting pool for the new round
  addPoolSnapshot(p1, 'Initial Pool');
  addPoolSnapshot(p2, 'Initial Pool');

  persistSession(session);
  emitState(session);
}

// ── STATE EMISSION ─────────────────────────────────────────────────
function emitState(session) {
  const { slots, players: { player1: p1, player2: p2 } } = session;
  const base = {
    sessionId: session.id,
    gameNumber: session.gameNumber,
    status: session.status,
    refreshLimit: session.refreshLimit,
    playerNames: session.playerNames,
    playerInfo: session.playerInfo,
    slotsOccupied: { player1: !!slots.player1, player2: !!slots.player2, admin: !!slots.admin },
    gameHistory: session.gameHistory,
    remainingPool: BOUNTY_POOL.length - session.usedBountyIds.size,
  };

  if (slots.player1) io.to(slots.player1).emit('state', { ...base, role: 'player1', myBounties: p1.bounties, mySelectedBounty: p1.selectedBounty, myLockedIn: p1.lockedIn, myConfirmedReady: p1.confirmedReady, myGameDoneReady: p1.gameDoneReady, refreshesUsed: p1.refreshesUsed, opponentLockedIn: p2.lockedIn, opponentConfirmedReady: p2.confirmedReady, opponentGameDoneReady: p2.gameDoneReady });
  if (slots.player2) io.to(slots.player2).emit('state', { ...base, role: 'player2', myBounties: p2.bounties, mySelectedBounty: p2.selectedBounty, myLockedIn: p2.lockedIn, myConfirmedReady: p2.confirmedReady, myGameDoneReady: p2.gameDoneReady, refreshesUsed: p2.refreshesUsed, opponentLockedIn: p1.lockedIn, opponentConfirmedReady: p1.confirmedReady, opponentGameDoneReady: p1.gameDoneReady });
  if (slots.admin) io.to(slots.admin).emit('state', { ...base, role: 'admin', player1Bounties: p1.bounties, player2Bounties: p2.bounties, player1Selected: p1.selectedBounty, player2Selected: p2.selectedBounty, player1LockedIn: p1.lockedIn, player2LockedIn: p2.lockedIn, player1ConfirmedReady: p1.confirmedReady, player2ConfirmedReady: p2.confirmedReady, player1GameDoneReady: p1.gameDoneReady, player2GameDoneReady: p2.gameDoneReady, player1RefreshesUsed: p1.refreshesUsed, player2RefreshesUsed: p2.refreshesUsed });
}

function exportSession(s) {
  return {
    sessionId: s.id,
    playerNames: s.playerNames,
    gameNumber: s.gameNumber,
    status: s.status,
    refreshLimit: s.refreshLimit,
    slotsOccupied: { player1: !!s.slots.player1, player2: !!s.slots.player2, admin: !!s.slots.admin },
    player1: { name: s.playerNames.player1, bounties: s.players.player1.bounties, selectedBounty: s.players.player1.selectedBounty, lockedIn: s.players.player1.lockedIn, refreshesUsed: s.players.player1.refreshesUsed },
    player2: { name: s.playerNames.player2, bounties: s.players.player2.bounties, selectedBounty: s.players.player2.selectedBounty, lockedIn: s.players.player2.lockedIn, refreshesUsed: s.players.player2.refreshesUsed },
    gameHistory: s.gameHistory,
    remainingPool: BOUNTY_POOL.length - s.usedBountyIds.size,
  };
}

// ── REST ROUTES ────────────────────────────────────────────────────
// After successful bcrypt login, we issue a session token stored in memory.
// All subsequent admin API calls send this token in x-admin-token header.
// Tokens expire after 24 hours and are cleared on server restart (by design).
const adminTokens = new Set();
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

function issueAdminToken() {
  const token = require('crypto').randomBytes(32).toString('hex');
  adminTokens.add(token);
  // Auto-expire after 24 hours
  setTimeout(() => adminTokens.delete(token), TOKEN_EXPIRY_MS);
  return token;
}

const requireAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/api/session', (req, res) => {
  const session = createSession();
  res.json({ sessionId: session.id });
});

app.get('/api/session/:id/slots', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ player1: !!s.slots.player1, player2: !!s.slots.player2, admin: !!s.slots.admin, playerNames: s.playerNames });
});

app.get('/api/session/:id/export', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(exportSession(s));
});

app.post('/api/admin/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // Check rate limit before doing anything
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${rateCheck.secsLeft} seconds.`, secsLeft: rateCheck.secsLeft });
  }

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required.' });

  // bcrypt.compare — hashes the input and checks against stored hash
  // never compares plain text, never stores plain text
  const match = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!match) {
    recordFailedAttempt(ip);
    const e = loginAttempts[ip];
    const remaining = Math.max(0, MAX_ATTEMPTS - (e?.count || 0));
    return res.status(401).json({ error: 'Wrong password.', attemptsRemaining: remaining });
  }

  // Success — clear attempts and issue a session token
  clearAttempts(ip);
  const token = issueAdminToken();
  res.json({ ok: true, token });
});

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  res.json(Object.values(sessions).map(s => ({ id: s.id, playerNames: s.playerNames, status: s.status, gameNumber: s.gameNumber, createdAt: s.createdAt })));
});

// Public session list — used by the overlay session picker.
// Only exposes sessions that are on game 3+, at least 90 minutes old,
// AND were created today — so stale sessions from previous days don't clutter the picker.
const PUBLIC_MIN_GAME = 3;
const PUBLIC_MIN_AGE_MS = 90 * 60 * 1000; // 90 minutes
app.get('/api/sessions', (req, res) => {
  const now = Date.now();
  const startOfToday = new Date('2025-04-07T00:00:00').getTime(); // April 7th only
  const visible = Object.values(sessions).filter(s =>
    s.gameNumber >= PUBLIC_MIN_GAME &&
    (now - (s.createdAt || 0)) >= PUBLIC_MIN_AGE_MS &&
    (s.createdAt || 0) >= startOfToday
  );
  res.json(visible.map(s => ({ id: s.id, playerNames: s.playerNames, status: s.status, gameNumber: s.gameNumber, createdAt: s.createdAt })));
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ globalDefaultRefreshLimit });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  if (req.body.globalDefaultRefreshLimit !== undefined) {
    globalDefaultRefreshLimit = Math.max(0, parseInt(req.body.globalDefaultRefreshLimit) || 0);
    persistSettings();
  }
  res.json({ ok: true, globalDefaultRefreshLimit });
});

app.post('/api/admin/session/:id/force-advance', requireAdmin, (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (session.status === 'locked_in') {
    session.status = 'in_game';
    session.players.player1.confirmedReady = true;
    session.players.player2.confirmedReady = true;
    persistSession(session); emitState(session);
  } else if (session.status === 'in_game') {
    advanceGame(session);
  }
  res.json({ ok: true });
});

app.post('/api/admin/session/:id/reset', requireAdmin, (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  session.gameNumber = 0; session.status = 'waiting';
  session.usedBountyIds = new Set(); session.gameHistory = [];
  session.players.player1 = freshPlayer(); session.players.player2 = freshPlayer();
  persistSession(session);
  if (session.slots.player1 && session.slots.player2) startFirstGame(session);
  else emitState(session);
  res.json({ ok: true });
});

app.post('/api/admin/session/:id/delete', requireAdmin, async (req, res) => {
  if (!sessions[req.params.id]) return res.status(404).json({ error: 'Not found' });
  delete sessions[req.params.id];
  await deleteSessionFromRedis(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/session/:id/refresh-limit', requireAdmin, (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  session.refreshLimit = Math.max(0, parseInt(req.body.limit) || 0);
  persistSession(session); emitState(session);
  res.json({ ok: true });
});

// Page routes
app.get('/overlay/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/join/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── SOCKET ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join', ({ sessionId, role, playerName, adminToken, manualElo }) => {
    const session = sessions[sessionId];
    if (!session) return socket.emit('err', { msg: 'Session not found.' });
    if (!['player1', 'player2', 'admin'].includes(role)) return socket.emit('err', { msg: 'Invalid role.' });
    if (role === 'admin' && (!adminToken || !adminTokens.has(adminToken))) {
      return socket.emit('err', { msg: 'Admin access requires login. Please visit /admin first.', redirect: '/admin' });
    }
    if (session.slots[role]) return socket.emit('err', { msg: 'That slot is already taken.' });
    if (role !== 'admin' && !playerName?.trim()) return socket.emit('err', { msg: 'Player name is required.' });
    session.slots[role] = socket.id;
    socket.data.sessionId = sessionId;
    socket.data.role = role;
    if (role !== 'admin') {
      const normalized = normalizeName(playerName);
      const lookupElo = PLAYER_ELO[normalized];
      const resolvedManualElo = parseInt(manualElo, 10);
      let resolvedElo = lookupElo;
      if (!resolvedElo && Number.isFinite(resolvedManualElo) && resolvedManualElo > 0) resolvedElo = resolvedManualElo;
      if (!resolvedElo) {
        session.slots[role] = null;
        socket.data.sessionId = null;
        socket.data.role = null;
        return socket.emit('err', { msg: 'Could not auto-find ELO for that name. Please enter your ELO.', requireManualElo: true });
      }
      session.playerNames[role] = playerName.trim();
      session.playerInfo[role] = {
        elo: resolvedElo,
        category: getCategoryForElo(resolvedElo),
      };
      const p1c = session.playerInfo.player1?.category;
      const p2c = session.playerInfo.player2?.category;
      const rank = { bottom: 0, middle: 1, top: 2 };
      if (p1c && p2c && p1c !== p2c) {
        session.playerInfo.player1.isHigherCategory = rank[p1c] > rank[p2c];
        session.playerInfo.player2.isHigherCategory = rank[p2c] > rank[p1c];
      } else {
        if (session.playerInfo.player1) session.playerInfo.player1.isHigherCategory = false;
        if (session.playerInfo.player2) session.playerInfo.player2.isHigherCategory = false;
      }
    }
    socket.join(sessionId);
    socket.emit('joined', { role, sessionId });
    persistSession(session);
    if (session.slots.player1 && session.slots.player2 && session.status === 'waiting') startFirstGame(session);
    else emitState(session);
  });

  socket.on('selectBounty', ({ bountyId }) => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (!['bounty_phase','locked_in'].includes(session.status)) return;
    if (session.players[role].lockedIn) return;
    const bounty = session.players[role].bounties.find(b => b.id === bountyId);
    if (!bounty) return;
    session.players[role].selectedBounty = bounty;
    persistSession(session); emitState(session);
  });

  socket.on('lockIn', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (session.status !== 'bounty_phase') return;
    if (!session.players[role].selectedBounty) return;
    if (session.players[role].lockedIn) return;
    session.players[role].lockedIn = true;
    // Update the last snapshot to mark the pick — we overwrite the label of the
    // most recent snapshot to indicate it is the lock-in state
    const snapshots = session.players[role].poolSnapshots;
    if (snapshots.length > 0) {
      const last = snapshots[snapshots.length - 1];
      last.lockedPool = last.pool.map(b => ({
        ...b,
        isPick: b.id === session.players[role].selectedBounty.id,
      }));
    }
    if (session.players.player1.lockedIn && session.players.player2.lockedIn) session.status = 'locked_in';
    persistSession(session); emitState(session);
  });

  socket.on('unlockIn', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (session.players[role].confirmedReady) return;
    if (!['bounty_phase','locked_in'].includes(session.status)) return;
    session.players[role].lockedIn = false;
    session.status = 'bounty_phase';
    persistSession(session); emitState(session);
  });

  socket.on('confirmReady', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (!session.players[role].lockedIn) return;
    if (session.players[role].confirmedReady) return;
    session.players[role].confirmedReady = true;
    if (session.players.player1.confirmedReady && session.players.player2.confirmedReady) {
      session.players.player1.gameDoneReady = false;
      session.players.player2.gameDoneReady = false;
      session.status = 'in_game';
    }
    persistSession(session); emitState(session);
  });

  socket.on('gameDone', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (session.status !== 'in_game') return;
    session.players[role].gameDoneReady = true;
    persistSession(session); emitState(session);
    if (session.players.player1.gameDoneReady && session.players.player2.gameDoneReady) advanceGame(session);
  });

  socket.on('refreshBounties', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (!['bounty_phase','locked_in'].includes(session.status)) return;
    if (session.players[role].lockedIn) return;
    const player = session.players[role];
    if (player.refreshesUsed >= session.refreshLimit) return socket.emit('err', { msg: 'No refreshes remaining.' });
    const otherRole = role === 'player1' ? 'player2' : 'player1';
    const otherIds = session.players[otherRole].bounties.map(b => b.id);
    const fresh = drawBounties(session.usedBountyIds, 6, otherIds, {
      level3Only: session.playerInfo[role]?.isHigherCategory === true,
    });
    if (fresh.length < 6) return socket.emit('err', { msg: 'Not enough bounties remaining to refresh.' });
    player.bounties = fresh;
    player.selectedBounty = null;
    player.refreshesUsed++;
    player.roundRefreshesUsed++;
    addPoolSnapshot(player, `After Refresh ${player.roundRefreshesUsed}`);
    persistSession(session); emitState(session);
  });

  socket.on('adminForceAdvance', () => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    if (session.status === 'locked_in') {
      session.status = 'in_game';
      session.players.player1.confirmedReady = true;
      session.players.player2.confirmedReady = true;
      persistSession(session); emitState(session);
    } else if (session.status === 'in_game') {
      advanceGame(session);
    }
  });

  socket.on('adminSetRefreshLimit', ({ limit }) => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    session.refreshLimit = Math.max(0, parseInt(limit) || 0);
    persistSession(session); emitState(session);
  });

  socket.on('adminResetSession', () => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    session.gameNumber = 0; session.status = 'waiting';
    session.usedBountyIds = new Set(); session.gameHistory = [];
    session.players.player1 = freshPlayer(); session.players.player2 = freshPlayer();
    persistSession(session);
    // startFirstGame will add the initial pool snapshots
    if (session.slots.player1 && session.slots.player2) startFirstGame(session);
    else emitState(session);
  });

  socket.on('disconnect', () => {
    const { sessionId, role } = socket.data || {};
    if (!sessionId || !sessions[sessionId]) return;
    const session = sessions[sessionId];
    if (session.slots[role] === socket.id) {
      session.slots[role] = null;
      emitState(session);
    }
  });
});

// ── START ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
loadFromRedis().then(() => {
  server.listen(PORT, () => console.log(`Bounty server running on http://localhost:${PORT}`));
});
