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

const sessions = {};

function drawBounties(usedIds, count = 6, exclude = []) {
  const available = BOUNTY_POOL.filter(b => !usedIds.has(b.id) && !exclude.includes(b.id));
  const shuffled = available.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function createSession(adminRefreshLimit) {
  const sessionId = uuidv4();
  const session = {
    id: sessionId,
    adminRefreshLimit: adminRefreshLimit || 3,
    slots: { player1: null, player2: null, admin: null },
    playerNames: { player1: null, player2: null },
    gameNumber: 0,
    status: 'waiting',
    usedBountyIds: new Set(),
    players: {
      player1: { bounties: [], selectedBounty: null, lockedIn: false, refreshesUsed: 0, nextGameReady: false, confirmedReady: false, gameDoneReady: false },
      player2: { bounties: [], selectedBounty: null, lockedIn: false, refreshesUsed: 0, nextGameReady: false, confirmedReady: false, gameDoneReady: false },
    },
    gameHistory: [],
  };
  sessions[sessionId] = session;
  return session;
}


function startBountyPhase(session) {
  session.gameNumber++;
  session.status = 'bounty_phase';
  for (const role of ['player1', 'player2']) {
    session.players[role].selectedBounty = null;
    session.players[role].lockedIn = false;
    session.players[role].nextGameReady = false;
  }
  const p1Bounties = drawBounties(session.usedBountyIds, 6, []);
  const p1Ids = p1Bounties.map(b => b.id);
  const p2Bounties = drawBounties(session.usedBountyIds, 6, p1Ids);
  session.players.player1.bounties = p1Bounties;
  session.players.player2.bounties = p2Bounties;
  emitSessionState(session);
}

function emitSessionState(session) {
  const slots = session.slots;
  const baseState = {
    sessionId: session.id,
    gameNumber: session.gameNumber,
    status: session.status,
    adminRefreshLimit: session.adminRefreshLimit,
    playerNames: session.playerNames,
    slotsOccupied: { player1: !!slots.player1, player2: !!slots.player2, admin: !!slots.admin },
    gameHistory: session.gameHistory,
  };

  if (slots.player1) {
    const p1 = session.players.player1;
    const p2 = session.players.player2;
    io.to(slots.player1).emit('state', { ...baseState, role: 'player1', myBounties: p1.bounties, mySelectedBounty: p1.selectedBounty, myLockedIn: p1.lockedIn, opponentLockedIn: p2.lockedIn, refreshesUsed: p1.refreshesUsed, myNextGameReady: p1.nextGameReady, opponentNextGameReady: p2.nextGameReady, myConfirmedReady: p1.confirmedReady, myGameDoneReady: p1.gameDoneReady, opponentGameDoneReady: p2.gameDoneReady });
  }
  if (slots.player2) {
    const p1 = session.players.player1;
    const p2 = session.players.player2;
    io.to(slots.player2).emit('state', { ...baseState, role: 'player2', myBounties: p2.bounties, mySelectedBounty: p2.selectedBounty, myLockedIn: p2.lockedIn, opponentLockedIn: p1.lockedIn, refreshesUsed: p2.refreshesUsed, myNextGameReady: p2.nextGameReady, opponentNextGameReady: p1.nextGameReady, myConfirmedReady: p2.confirmedReady, myGameDoneReady: p2.gameDoneReady, opponentGameDoneReady: p1.gameDoneReady });
  }
  if (slots.admin) {
    const p1 = session.players.player1;
    const p2 = session.players.player2;
    io.to(slots.admin).emit('state', { ...baseState, role: 'admin', player1Bounties: p1.bounties, player2Bounties: p2.bounties, player1Selected: p1.selectedBounty, player2Selected: p2.selectedBounty, player1LockedIn: p1.lockedIn, player2LockedIn: p2.lockedIn, player1RefreshesUsed: p1.refreshesUsed, player2RefreshesUsed: p2.refreshesUsed, player1NextGameReady: p1.nextGameReady, player2NextGameReady: p2.nextGameReady, player1GameDoneReady: p1.gameDoneReady, player2GameDoneReady: p2.gameDoneReady });
  }
}

app.post('/api/session', (req, res) => {
  const { adminRefreshLimit } = req.body;
  const session = createSession(adminRefreshLimit);
  res.json({ sessionId: session.id });
});

app.get('/api/session/:sessionId/slots', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ player1: !!session.slots.player1, player2: !!session.slots.player2, admin: !!session.slots.admin, playerNames: session.playerNames });
});

app.get('/join/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function advanceGame(session) {
  session.gameHistory.push({ game: session.gameNumber, player1: session.players.player1.selectedBounty, player2: session.players.player2.selectedBounty });
  if (session.players.player1.selectedBounty) session.usedBountyIds.add(session.players.player1.selectedBounty.id);
  if (session.players.player2.selectedBounty) session.usedBountyIds.add(session.players.player2.selectedBounty.id);
  startBountyPhase(session);
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address;

  socket.on('join', ({ sessionId, role, playerName }) => {
    const session = sessions[sessionId];
    if (!session) return socket.emit('error', { message: 'Session not found.' });
    if (!['player1', 'player2', 'admin'].includes(role)) return socket.emit('error', { message: 'Invalid role.' });
    if (session.slots[role]) return socket.emit('error', { message: `That slot is already taken.` });
    session.slots[role] = socket.id;
    socket.data.sessionId = sessionId;
    socket.data.role = role;
    if (role !== 'admin') session.playerNames[role] = playerName || role;
    socket.join(sessionId);
    socket.emit('joined', { role, sessionId });
    if (session.slots.player1 && session.slots.player2 && session.status === 'waiting') {
      startBountyPhase(session);
    } else {
      emitSessionState(session);
    }
  });

  socket.on('selectBounty', ({ bountyId }) => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (role !== 'player1' && role !== 'player2') return;
    if (session.status !== 'bounty_phase') return;
    if (session.players[role].lockedIn) return;
    const bounty = session.players[role].bounties.find(b => b.id === bountyId);
    if (!bounty) return;
    session.players[role].selectedBounty = bounty;
    emitSessionState(session);
  });

  socket.on('lockIn', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (role !== 'player1' && role !== 'player2') return;
    if (session.status !== 'bounty_phase') return;
    if (!session.players[role].selectedBounty) return;
    if (session.players[role].lockedIn) return;
    session.players[role].lockedIn = true;
    if (session.players.player1.lockedIn && session.players.player2.lockedIn) session.status = 'locked_in';
    emitSessionState(session);
  });

  socket.on('unlockIn', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (role !== 'player1' && role !== 'player2') return;
    if (session.status !== 'bounty_phase' && session.status !== 'locked_in') return;
    session.players[role].lockedIn = false;
    session.status = 'bounty_phase';
    emitSessionState(session);
  });

  socket.on('refreshBounties', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (role !== 'player1' && role !== 'player2') return;
    if (session.status !== 'bounty_phase') return;
    if (session.players[role].lockedIn) return;
    const player = session.players[role];
    if (player.refreshesUsed >= session.adminRefreshLimit) return socket.emit('error', { message: 'No refreshes remaining.' });
    const otherRole = role === 'player1' ? 'player2' : 'player1';
    const otherIds = session.players[otherRole].bounties.map(b => b.id);
    const newBounties = drawBounties(session.usedBountyIds, 6, otherIds);
    if (newBounties.length < 6) return socket.emit('error', { message: 'Not enough bounties in pool to refresh.' });
    player.bounties = newBounties;
    player.selectedBounty = null;
    player.refreshesUsed++;
    emitSessionState(session);
  });

  socket.on('nextGameReady', () => {
    const session = sessions[socket.data.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (role !== 'player1' && role !== 'player2') return;

    // From locked_in → confirm both players → move to 'in_game'
    if (session.status === 'locked_in') {
      session.players[role].confirmedReady = true;
      if (session.players.player1.confirmedReady && session.players.player2.confirmedReady) {
        session.players.player1.confirmedReady = false;
        session.players.player2.confirmedReady = false;
        session.players.player1.gameDoneReady = false;
        session.players.player2.gameDoneReady = false;
        session.status = 'in_game';
      }
      emitSessionState(session);
      return;
    }

    // From in_game → both click game done → advance
    if (session.status === 'in_game') {
      session.players[role].gameDoneReady = true;
      emitSessionState(session);
      if (session.players.player1.gameDoneReady && session.players.player2.gameDoneReady) {
        advanceGame(session);
      }
      return;
    }
  });

  socket.on('adminAdvanceGame', () => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    if (session.status === 'locked_in') {
      session.players.player1.confirmedReady = false;
      session.players.player2.confirmedReady = false;
      session.status = 'in_game';
      emitSessionState(session);
    } else if (session.status === 'in_game') {
      advanceGame(session);
    }
  });

  socket.on('adminSetRefreshLimit', ({ limit }) => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    session.adminRefreshLimit = Math.max(0, parseInt(limit) || 0);
    emitSessionState(session);
  });

  socket.on('adminResetSession', () => {
    const session = sessions[socket.data.sessionId];
    if (!session || socket.data.role !== 'admin') return;
    session.gameNumber = 0;
    session.status = 'waiting';
    session.usedBountyIds = new Set();
    session.gameHistory = [];
    session.players.player1 = { bounties: [], selectedBounty: null, lockedIn: false, refreshesUsed: 0, nextGameReady: false, confirmedReady: false, gameDoneReady: false };
    session.players.player2 = { bounties: [], selectedBounty: null, lockedIn: false, refreshesUsed: 0, nextGameReady: false, confirmedReady: false, gameDoneReady: false };
    if (session.slots.player1 && session.slots.player2) startBountyPhase(session);
    else emitSessionState(session);
  });

  socket.on('disconnect', () => {
    const session = sessions[socket.data?.sessionId];
    if (!session) return;
    const role = socket.data.role;
    if (role && session.slots[role] === socket.id) {
      session.slots[role] = null;
      emitSessionState(session);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bounty server running on http://localhost:${PORT}`));
