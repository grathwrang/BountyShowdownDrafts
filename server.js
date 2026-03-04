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

const BOUNTY_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, 'bounties.json')));
const ADMIN_PASSWORD = 'passwrang321';

// Global default refresh limit (admin can change)
let globalDefaultRefreshLimit = 2;

const sessions = {};

// ── HELPERS ────────────────────────────────────────────────────────
function drawBounties(usedIds, count = 6, excludeIds = []) {
  const available = BOUNTY_POOL.filter(b => !usedIds.has(b.id) && !excludeIds.includes(b.id));
  return available.sort(() => Math.random() - 0.5).slice(0, count);
}

function freshPlayer() {
  return {
    bounties: [],
    selectedBounty: null,
    lockedIn: false,
    confirmedReady: false,
    gameDoneReady: false,
    refreshesUsed: 0,  // per-set
  };
}

function createSession() {
  const sessionId = uuidv4();
  const session = {
    id: sessionId,
    refreshLimit: globalDefaultRefreshLimit,
    slots: { player1: null, player2: null, admin: null },
    playerNames: { player1: null, player2: null },
    gameNumber: 0,
    status: 'waiting',
    usedBountyIds: new Set(),
    players: { player1: freshPlayer(), player2: freshPlayer() },
    gameHistory: [],
    createdAt: Date.now(),
  };
  sessions[sessionId] = session;
  return session;
}

function startFirstGame(session) {
  session.gameNumber = 1;
  session.status = 'bounty_phase';
  const p1 = drawBounties(session.usedBountyIds, 6, []);
  const p1Ids = p1.map(b => b.id);
  const p2 = drawBounties(session.usedBountyIds, 6, p1Ids);
  session.players.player1.bounties = p1;
  session.players.player2.bounties = p2;
  emitState(session);
}

function advanceGame(session) {
  const p1 = session.players.player1;
  const p2 = session.players.player2;

  // Record history
  session.gameHistory.push({
    game: session.gameNumber,
    player1: p1.selectedBounty,
    player2: p2.selectedBounty,
  });

  // Mark used
  if (p1.selectedBounty) session.usedBountyIds.add(p1.selectedBounty.id);
  if (p2.selectedBounty) session.usedBountyIds.add(p2.selectedBounty.id);

  session.gameNumber++;
  session.status = 'bounty_phase';

  // Remove used bounty from each player's pool (pool shrinks)
  p1.bounties = p1.bounties.filter(b => !session.usedBountyIds.has(b.id));
  p2.bounties = p2.bounties.filter(b => !session.usedBountyIds.has(b.id));

  // Reset per-game state (NOT refreshesUsed — that's per-set)
  p1.selectedBounty = null;
  p1.lockedIn = false;
  p1.confirmedReady = false;
  p1.gameDoneReady = false;

  p2.selectedBounty = null;
  p2.lockedIn = false;
  p2.confirmedReady = false;
  p2.gameDoneReady = false;

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
    slotsOccupied: { player1: !!slots.player1, player2: !!slots.player2, admin: !!slots.admin },
    gameHistory: session.gameHistory,
    remainingPool: BOUNTY_POOL.length - session.usedBountyIds.size,
  };

  if (slots.player1) {
    io.to(slots.player1).emit('state', {
      ...base, role: 'player1',
      myBounties: p1.bounties,
      mySelectedBounty: p1.selectedBounty,
      myLockedIn: p1.lockedIn,
      myConfirmedReady: p1.confirmedReady,
      myGameDoneReady: p1.gameDoneReady,
      refreshesUsed: p1.refreshesUsed,
      opponentLockedIn: p2.lockedIn,
      opponentConfirmedReady: p2.confirmedReady,
      opponentGameDoneReady: p2.gameDoneReady,
    });
  }
  if (slots.player2) {
    io.to(slots.player2).emit('state', {
      ...base, role: 'player2',
      myBounties: p2.bounties,
      mySelectedBounty: p2.selectedBounty,
      myLockedIn: p2.lockedIn,
      myConfirmedReady: p2.confirmedReady,
      myGameDoneReady: p2.gameDoneReady,
      refreshesUsed: p2.refreshesUsed,
      opponentLockedIn: p1.lockedIn,
      opponentConfirmedReady: p1.confirmedReady,
      opponentGameDoneReady: p1.gameDoneReady,
    });
  }
  if (slots.admin) {
    io.to(slots.admin).emit('state', {
      ...base, role: 'admin',
      player1Bounties: p1.bounties,
      player2Bounties: p2.bounties,
      player1Selected: p1.selectedBounty,
      player2Selected: p2.selectedBounty,
      player1LockedIn: p1.lockedIn,
      player2LockedIn: p2.lockedIn,
      player1ConfirmedReady: p1.confirmedReady,
      player2ConfirmedReady: p2.confirmedReady,
      player1GameDoneReady: p1.gameDoneReady,
      player2GameDoneReady: p2.gameDoneReady,
      player1RefreshesUsed: p1.refreshesUsed,
      player2RefreshesUsed: p2.refreshesUsed,
    });
  }
}

// ── REST ROUTES ────────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const session = createSession();
  res.json({ sessionId: session.id });
});

app.get('/api/session/:id/slots', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({
    player1: !!s.slots.player1,
    player2: !!s.slots.player2,
    admin: !!s.slots.admin,
    playerNames: s.playerNames,
  });
});

// Admin dashboard API — password protected
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.get('/api/admin/sessions', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const list = Object.values(sessions).map(s => ({
    id: s.id,
    playerNames: s.playerNames,
    status: s.status,
    gameNumber: s.gameNumber,
    createdAt: s.createdAt,
  }));
  res.json(list);
});

app.get('/api/admin/settings', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ globalDefaultRefreshLimit });
});

app.post('/api/admin/settings', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (req.body.globalDefaultRefreshLimit !== undefined) {
    globalDefaultRefreshLimit = Math.max(0, parseInt(req.body.globalDefaultRefreshLimit) || 0);
  }
  res.json({ ok: true, globalDefaultRefreshLimit });
});

// JSON export for overlay
app.get('/api/session/:id/export', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({
    sessionId: s.id,
    playerNames: s.playerNames,
    gameNumber: s.gameNumber,
    status: s.status,
    refreshLimit: s.refreshLimit,
    slotsOccupied: { player1: !!s.slots.player1, player2: !!s.slots.player2, admin: !!s.slots.admin },
    player1: {
      name: s.playerNames.player1,
      bounties: s.players.player1.bounties,
      selectedBounty: s.players.player1.selectedBounty,
      lockedIn: s.players.player1.lockedIn,
      refreshesUsed: s.players.player1.refreshesUsed,
    },
    player2: {
      name: s.playerNames.player2,
      bounties: s.players.player2.bounties,
      selectedBounty: s.players.player2.selectedBounty,
      lockedIn: s.players.player2.lockedIn,
      refreshesUsed: s.players.player2.refreshesUsed,
    },
    gameHistory: s.gameHistory,
    remainingPool: BOUNTY_POOL.length - s.usedBountyIds.size,
  });
});

// Admin REST actions (used by admin dashboard page)
app.post('/api/admin/session/:id/force-advance', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  if (session.status === 'locked_in') {
    session.status = 'in_game';
    session.players.player1.confirmedReady = true;
    session.players.player2.confirmedReady = true;
    emitState(session);
  } else if (session.status === 'in_game') {
    advanceGame(session);
  }
  res.json({ ok: true });
});

app.post('/api/admin/session/:id/reset', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  session.gameNumber = 0;
  session.status = 'waiting';
  session.usedBountyIds = new Set();
  session.gameHistory = [];
  session.players.player1 = freshPlayer();
  session.players.player2 = freshPlayer();
  if (session.slots.player1 && session.slots.player2) startFirstGame(session);
  else emitState(session);
  res.json({ ok: true });
});

app.post('/api/admin/session/:id/refresh-limit', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  session.refreshLimit = Math.max(0, parseInt(req.body.limit) || 0);
  emitState(session);
  res.json({ ok: true });
});

app.get('/overlay/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/join/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── SOCKET ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join', ({ sessionId, role, playerName }) => {
    const session = sessions[sessionId];
    if (!session) return socket.emit('err', { msg: 'Session not found.' });
    if (!['player1', 'player2', 'admin'].includes(role)) return socket.emit('err', { msg: 'Invalid role.' });
    if (session.slots[role]) return socket.emit('err', { msg: 'That slot is already taken.' });

    session.slots[role] = socket.id;
    socket.data.sessionId = sessionId;
    socket.data.role = role;
    if (role !== 'admin') session.playerNames[role] = playerName || role;

    socket.join(sessionId);
    socket.emit('joined', { role, sessionId });

    if (session.slots.player1 && session.slots.player2 && session.status === 'waiting') {
      startFirstGame(session);
    } else {
      emitState(session);
    }
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
    emitState(session);
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
    if (session.players.player1.lockedIn && session.players.player2.lockedIn) session.status = 'locked_in';
    emitState(session);
  });

  socket.on('unlockIn', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    // Cannot go back if already confirmed
    if (session.players[role].confirmedReady) return;
    if (!['bounty_phase','locked_in'].includes(session.status)) return;
    session.players[role].lockedIn = false;
    session.status = 'bounty_phase';
    emitState(session);
  });

  socket.on('confirmReady', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    // Can confirm as long as locked in (even if status is still bounty_phase — opponent not locked yet)
    if (!session.players[role].lockedIn) return;
    if (session.players[role].confirmedReady) return;
    session.players[role].confirmedReady = true;
    // If both confirmed, move to in_game
    if (session.players.player1.confirmedReady && session.players.player2.confirmedReady) {
      session.players.player1.gameDoneReady = false;
      session.players.player2.gameDoneReady = false;
      session.status = 'in_game';
    }
    emitState(session);
  });

  socket.on('gameDone', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (!['player1','player2'].includes(role)) return;
    if (session.status !== 'in_game') return;
    session.players[role].gameDoneReady = true;
    emitState(session);
    if (session.players.player1.gameDoneReady && session.players.player2.gameDoneReady) {
      advanceGame(session);
    }
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
    const fresh = drawBounties(session.usedBountyIds, 6, otherIds);
    if (fresh.length < 6) return socket.emit('err', { msg: 'Not enough bounties remaining to refresh.' });
    player.bounties = fresh;
    player.selectedBounty = null;
    player.refreshesUsed++;
    emitState(session);
  });

  // Admin socket actions
  socket.on('adminForceAdvance', () => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    if (session.status === 'locked_in') {
      session.status = 'in_game';
      session.players.player1.confirmedReady = true;
      session.players.player2.confirmedReady = true;
      emitState(session);
    } else if (session.status === 'in_game') {
      advanceGame(session);
    }
  });

  socket.on('adminSetRefreshLimit', ({ limit }) => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    session.refreshLimit = Math.max(0, parseInt(limit) || 0);
    emitState(session);
  });

  socket.on('adminResetSession', () => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    session.gameNumber = 0;
    session.status = 'waiting';
    session.usedBountyIds = new Set();
    session.gameHistory = [];
    session.players.player1 = freshPlayer();
    session.players.player2 = freshPlayer();
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bounty server running on http://localhost:${PORT}`));
