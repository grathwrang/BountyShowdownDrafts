// ── STREAM BOUNTY SHOW ─────────────────────────────────────────────
// A single persistent board that lives for the whole stream.
//
// Loop: the wheel picks a viewer → they choose a bounty off the board →
// they queue a ranked 1v1 → we watch. The host drives everything from
// here with three buttons:
//
//   CLAIM      bounty completed. Name goes on the tile for the rest of
//              the stream, the tile's dollar value is paid out.
//   FAIL       bounty blown but the game is still live. Stamps the
//              overlay until the game ends — they can still win the game
//              and bank wheel spots.
//   GAME END   the 1v1 finished. An unclaimed bounty gains a dollar and
//              goes back on the board; the FAILED stamp clears.
//
// Every action is exposed as both GET and POST so a Stream Deck button
// (which can only fire a URL) and streamer.bot can drive the same thing.

const crypto = require('crypto');

const DEFAULTS = {
  boardSize: 12,      // tiles on the board — 4 per level, reads as a 4x3 grid
  startingValue: 10,  // every bounty opens at $10
  increment: 1,       // a failed bounty gains $1 for the next challenger
};

const MAX_LOG = 300;
const MAX_UNDO = 40;

function normalizeName(name = '') {
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = function mountShow({ app, io, bountyPool, redisCmd, requireAdmin }) {
  // ── STATE ────────────────────────────────────────────────────────
  // Seeded synchronously so the routes below are safe to hit before the
  // saved show comes back from Redis; load() then replaces it.
  let show = null;
  const undoStack = [];

  // Stream Deck buttons carry the key in the URL, so it has to be stable
  // across restarts — env var first, then whatever we persisted, then new.
  let showKey = process.env.SHOW_API_KEY || null;

  function freshPlayer(displayName) {
    return {
      name: displayName,
      attempts: 0,
      claims: 0,
      fails: 0,
      gameWins: 0,
      gameLosses: 0,
      wheelSpots: 0,
      earned: 0,
      bounties: [],   // [{ id, title, value, ts }] — what they've claimed
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };
  }

  function makeTile(bounty, value) {
    return {
      id: bounty.id,
      title: bounty.title,
      description: bounty.description,
      level: bounty.level,
      value,
      status: 'open',      // 'open' | 'claimed'
      claimedBy: null,
      claimedAt: null,
      attempts: 0,
      fails: 0,
    };
  }

  // Deal a board balanced across the three levels.
  function drawBoard(size, excludeIds = []) {
    const exclude = new Set(excludeIds);
    const available = bountyPool.filter(b => !exclude.has(b.id));
    const perLevel = Math.floor(size / 3);
    const byLevel = { 1: [], 2: [], 3: [] };
    available.forEach(b => { if (byLevel[b.level]) byLevel[b.level].push(b); });

    const picked = [];
    for (const level of [1, 2, 3]) {
      const shuffled = byLevel[level].sort(() => Math.random() - 0.5);
      picked.push(...shuffled.slice(0, perLevel));
    }
    if (picked.length < size) {
      const pickedIds = new Set(picked.map(b => b.id));
      picked.push(...available
        .filter(b => !pickedIds.has(b.id))
        .sort(() => Math.random() - 0.5)
        .slice(0, size - picked.length));
    }
    return picked.sort(() => Math.random() - 0.5).slice(0, size);
  }

  function freshShow(config = {}, players = {}) {
    const cfg = { ...DEFAULTS, ...config };
    return {
      startedAt: Date.now(),
      config: cfg,
      board: drawBoard(cfg.boardSize).map(b => makeTile(b, cfg.startingValue)),
      active: null,
      players,
      log: [],
      totals: { claims: 0, paidOut: 0, attempts: 0 },
      event: null,
    };
  }

  // ── PERSISTENCE ──────────────────────────────────────────────────
  async function persist() {
    await redisCmd('SET', 'show:current', JSON.stringify(show));
  }

  async function loadShow() {
    try {
      const raw = await redisCmd('GET', 'show:current');
      if (raw) {
        show = JSON.parse(raw);
        show.config = { ...DEFAULTS, ...(show.config || {}) };
        show.players = show.players || {};
        show.log = show.log || [];
        show.totals = show.totals || { claims: 0, paidOut: 0, attempts: 0 };
        console.log(`Restored bounty show: ${show.board.length} tiles, ${Object.keys(show.players).length} players`);
      }
      if (!showKey) {
        showKey = await redisCmd('GET', 'show:key');
      }
    } catch (e) {
      console.error('Error restoring show:', e.message);
    }
    if (!show) show = freshShow();
    if (!showKey) {
      showKey = crypto.randomBytes(16).toString('hex');
      await redisCmd('SET', 'show:key', showKey);
    }
    console.log(`Bounty show API key: ${showKey}`);
  }

  // ── SNAPSHOTS (undo) ─────────────────────────────────────────────
  function snapshot(label) {
    undoStack.push({
      label,
      ts: Date.now(),
      state: JSON.stringify({
        board: show.board,
        active: show.active,
        players: show.players,
        totals: show.totals,
      }),
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return { ok: false, error: 'Nothing to undo.' };
    const prev = JSON.parse(entry.state);
    show.board = prev.board;
    show.active = prev.active;
    show.players = prev.players;
    show.totals = prev.totals;
    show.log.unshift({ ts: Date.now(), type: 'undo', message: `Undid: ${entry.label}` });
    show.log = show.log.slice(0, MAX_LOG);
    show.event = null;
    commit();
    return { ok: true, undid: entry.label };
  }

  // ── HELPERS ──────────────────────────────────────────────────────
  function tile(bountyId) {
    return show.board.find(t => String(t.id) === String(bountyId));
  }

  function activeTile() {
    return show.active ? tile(show.active.bountyId) : null;
  }

  function player(name, create = true) {
    const key = normalizeName(name);
    if (!key) return null;
    if (!show.players[key] && create) show.players[key] = freshPlayer(String(name).trim());
    const p = show.players[key];
    if (p) {
      p.name = String(name).trim() || p.name;   // keep their latest casing
      p.lastSeen = Date.now();
    }
    return p;
  }

  function logEvent(entry) {
    show.log.unshift({ ts: Date.now(), ...entry });
    show.log = show.log.slice(0, MAX_LOG);
  }

  // An overlay animation trigger. The id lets the overlay ignore events
  // it has already played, so a browser-source refresh mid-stream doesn't
  // replay the last "BOUNTY CLAIMED".
  function fireEvent(kind, payload) {
    show.event = { id: crypto.randomBytes(8).toString('hex'), kind, ts: Date.now(), ...payload };
    io.emit('show:event', show.event);
  }

  function commit() {
    persist();
    io.emit('show:state', publicState());
  }

  // ── PUBLIC STATE ─────────────────────────────────────────────────
  function publicState() {
    const at = activeTile();
    return {
      startedAt: show.startedAt,
      config: show.config,
      board: show.board,
      active: show.active ? { ...show.active, bounty: at || null } : null,
      totals: show.totals,
      event: show.event,
      openCount: show.board.filter(t => t.status === 'open').length,
      claimedCount: show.board.filter(t => t.status === 'claimed').length,
      boardValue: show.board.filter(t => t.status === 'open').reduce((sum, t) => sum + t.value, 0),
      log: show.log.slice(0, 40),
      players: leaderboard(),
    };
  }

  function leaderboard() {
    return Object.values(show.players)
      .sort((a, b) => b.claims - a.claims || b.earned - a.earned || b.wheelSpots - a.wheelSpots)
      .map(p => ({
        name: p.name,
        attempts: p.attempts,
        claims: p.claims,
        fails: p.fails,
        gameWins: p.gameWins,
        gameLosses: p.gameLosses,
        wheelSpots: p.wheelSpots,
        earned: p.earned,
        bounties: p.bounties,
      }));
  }

  // ── ACTIONS ──────────────────────────────────────────────────────
  function actionSelect({ player: playerName, bounty: bountyId }) {
    if (!playerName?.trim()) return { ok: false, error: 'Player name is required.' };
    const t = tile(bountyId);
    if (!t) return { ok: false, error: 'That bounty is not on the board.' };
    if (t.status === 'claimed') return { ok: false, error: `Already claimed by ${t.claimedBy}.` };

    snapshot(`select ${t.title}`);
    const p = player(playerName);
    show.active = {
      player: p.name,
      bountyId: t.id,
      startedAt: Date.now(),
      bountyFailed: false,
      failedAt: null,
    };
    logEvent({ type: 'select', player: p.name, bounty: t.title, value: t.value });
    fireEvent('selected', { player: p.name, bounty: t, value: t.value });
    commit();
    return { ok: true, active: show.active, bounty: t };
  }

  function actionClaim() {
    if (!show.active) return { ok: false, error: 'Nobody has a bounty in play.' };
    const t = activeTile();
    if (!t) return { ok: false, error: 'Active bounty is no longer on the board.' };

    snapshot(`claim ${t.title}`);
    const p = player(show.active.player);
    const value = t.value;

    t.status = 'claimed';
    t.claimedBy = p.name;
    t.claimedAt = Date.now();
    t.attempts++;

    // Every bounty in the pool requires winning the game, so a claim is
    // also a game win — and therefore a wheel spot.
    p.attempts++;
    p.claims++;
    p.gameWins++;
    p.wheelSpots++;
    p.earned += value;
    p.bounties.push({ id: t.id, title: t.title, value, ts: Date.now() });

    show.totals.claims++;
    show.totals.attempts++;
    show.totals.paidOut += value;

    logEvent({ type: 'claim', player: p.name, bounty: t.title, value });
    fireEvent('claimed', { player: p.name, bounty: t, value });
    show.active = null;
    commit();
    return { ok: true, player: p.name, bounty: t.title, value };
  }

  function actionFail() {
    if (!show.active) return { ok: false, error: 'Nobody has a bounty in play.' };
    if (show.active.bountyFailed) return { ok: false, error: 'Already flagged as failed.' };
    const t = activeTile();

    snapshot(`fail ${t?.title || 'bounty'}`);
    show.active.bountyFailed = true;
    show.active.failedAt = Date.now();
    logEvent({ type: 'fail', player: show.active.player, bounty: t?.title });
    fireEvent('failed', { player: show.active.player, bounty: t, value: t?.value });
    commit();
    return { ok: true, player: show.active.player, bounty: t?.title };
  }

  function actionUnfail() {
    if (!show.active) return { ok: false, error: 'Nobody has a bounty in play.' };
    snapshot('clear failed flag');
    show.active.bountyFailed = false;
    show.active.failedAt = null;
    show.event = null;
    logEvent({ type: 'unfail', player: show.active.player });
    commit();
    return { ok: true };
  }

  // The 1v1 is over. An unclaimed bounty gains a dollar and the FAILED
  // stamp comes off. A game win still banks a wheel spot.
  function actionGameEnd({ result }) {
    if (!show.active) return { ok: false, error: 'Nobody has a bounty in play.' };
    const t = activeTile();
    const won = result === 'win';

    snapshot(`game end (${won ? 'win' : 'loss'})`);
    const p = player(show.active.player);
    const oldValue = t ? t.value : 0;

    if (t) {
      t.attempts++;
      t.fails++;
      t.value += show.config.increment;
    }
    p.attempts++;
    p.fails++;
    if (won) { p.gameWins++; p.wheelSpots++; } else { p.gameLosses++; }
    show.totals.attempts++;

    logEvent({
      type: 'game-end',
      player: p.name,
      bounty: t?.title,
      result: won ? 'win' : 'loss',
      value: t ? t.value : null,
      message: t ? `$${oldValue} → $${t.value}` : null,
    });
    fireEvent('ended', {
      player: p.name,
      bounty: t,
      result: won ? 'win' : 'loss',
      oldValue,
      newValue: t ? t.value : null,
      wheelSpot: won,
    });
    show.active = null;
    commit();
    return { ok: true, result: won ? 'win' : 'loss', bounty: t?.title, newValue: t?.value };
  }

  // Wheel misfire, no-show, wrong tile clicked — wipe the attempt clean.
  function actionCancel() {
    if (!show.active) return { ok: false, error: 'Nobody has a bounty in play.' };
    snapshot('cancel attempt');
    logEvent({ type: 'cancel', player: show.active.player });
    show.active = null;
    show.event = null;
    commit();
    return { ok: true };
  }

  function actionReroll({ bounty: bountyId }) {
    const t = tile(bountyId);
    if (!t) return { ok: false, error: 'That bounty is not on the board.' };
    if (t.status === 'claimed') return { ok: false, error: 'Cannot reroll a claimed bounty.' };
    if (show.active && String(show.active.bountyId) === String(t.id)) {
      return { ok: false, error: 'That bounty is in play right now.' };
    }
    const onBoard = show.board.map(x => x.id);
    const replacement = drawBoard(1, onBoard)[0];
    if (!replacement) return { ok: false, error: 'No unused bounties left in the pool.' };

    snapshot(`reroll ${t.title}`);
    const idx = show.board.findIndex(x => String(x.id) === String(t.id));
    show.board[idx] = makeTile(replacement, show.config.startingValue);
    logEvent({ type: 'reroll', bounty: t.title, message: `→ ${replacement.title}` });
    commit();
    return { ok: true, replaced: t.title, with: replacement.title };
  }

  function actionSetValue({ bounty: bountyId, value }) {
    const t = tile(bountyId);
    if (!t) return { ok: false, error: 'That bounty is not on the board.' };
    const next = parseInt(value, 10);
    if (!Number.isFinite(next) || next < 0) return { ok: false, error: 'Invalid value.' };
    snapshot(`set ${t.title} to $${next}`);
    t.value = next;
    logEvent({ type: 'set-value', bounty: t.title, value: next });
    commit();
    return { ok: true, bounty: t.title, value: next };
  }

  function actionNewBoard({ players: playersMode, boardSize, startingValue, increment } = {}) {
    snapshot('new board');
    const config = {
      ...show.config,
      ...(boardSize ? { boardSize: Math.min(24, Math.max(3, parseInt(boardSize, 10) || DEFAULTS.boardSize)) } : {}),
      ...(startingValue !== undefined ? { startingValue: Math.max(0, parseInt(startingValue, 10) || 0) } : {}),
      ...(increment !== undefined ? { increment: Math.max(0, parseInt(increment, 10) || 0) } : {}),
    };
    const keepPlayers = playersMode !== 'reset';
    show = freshShow(config, keepPlayers ? show.players : {});
    logEvent({ type: 'new-board', message: keepPlayers ? 'New board dealt' : 'New board dealt, player stats cleared' });
    commit();
    return { ok: true, board: show.board.length };
  }

  // ── ROUTES ───────────────────────────────────────────────────────
  // Stream Deck can only fire a plain URL, so every action answers to GET
  // as well as POST, and takes its key from the query string.
  function authed(req) {
    const key = req.query.key || req.body?.key || req.headers['x-show-key'];
    if (key && showKey && key === showKey) return true;
    const token = req.headers['x-admin-token'] || req.query.token;
    return !!(token && adminTokenValid(token));
  }

  let adminTokenValid = () => false;
  function setAdminTokenValidator(fn) { adminTokenValid = fn; }

  function action(routePath, handler) {
    app.all('/api/show/' + routePath, (req, res) => {
      if (!authed(req)) return res.status(401).json({ ok: false, error: 'Unauthorized — bad or missing key.' });
      const params = { ...req.query, ...(req.body || {}) };
      const result = handler(params);
      res.status(result.ok ? 200 : 400).json(result);
    });
  }

  // Read-only — the overlay, the board scene and the leaderboard site
  // all pull these, so they stay open.
  app.get('/api/show/state', (req, res) => res.json(publicState()));
  app.get('/api/show/board', (req, res) => res.json({ board: show.board, config: show.config }));
  app.get('/api/show/leaderboard', (req, res) => res.json({
    startedAt: show.startedAt,
    totals: show.totals,
    players: leaderboard(),
    claimed: show.board.filter(t => t.status === 'claimed').map(t => ({
      id: t.id, title: t.title, level: t.level, value: t.value,
      claimedBy: t.claimedBy, claimedAt: t.claimedAt,
    })),
  }));

  action('select', actionSelect);
  action('claim', actionClaim);
  action('fail', actionFail);
  action('unfail', actionUnfail);
  action('game-end', actionGameEnd);
  action('game-won', () => actionGameEnd({ result: 'win' }));
  action('game-lost', () => actionGameEnd({ result: 'loss' }));
  action('cancel', actionCancel);
  action('undo', undo);
  action('reroll', actionReroll);
  action('set-value', actionSetValue);
  action('new-board', actionNewBoard);

  // The control panel needs the key to build Stream Deck URLs — admin only.
  app.get('/api/show/key', requireAdmin, (req, res) => res.json({ key: showKey }));

  show = freshShow();

  io.on('connection', (socket) => {
    socket.emit('show:state', publicState());
  });

  return {
    load: loadShow,
    setAdminTokenValidator,
    getState: publicState,
  };
};
