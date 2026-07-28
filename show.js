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

const MIN_BOARD = 1;
const MAX_BOARD = 40;

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

  // Bounties typed in by hand from the control panel. They live alongside
  // bounties.json in the draw pool and survive restarts and new boards.
  let customBounties = [];

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

  // Everything that can be drawn: the file-backed pool plus hand-typed ones.
  function fullPool() {
    return [...bountyPool, ...customBounties];
  }

  function poolBounty(id) {
    return fullPool().find(b => String(b.id) === String(id)) || null;
  }

  // Deal a board balanced across the three levels.
  function drawBoard(size, excludeIds = []) {
    const exclude = new Set(excludeIds.map(String));
    const available = fullPool().filter(b => !exclude.has(String(b.id)));
    const perLevel = Math.floor(size / 3);
    const byLevel = { 1: [], 2: [], 3: [] };
    available.forEach(b => { if (byLevel[b.level]) byLevel[b.level].push(b); });

    const picked = [];
    for (const level of [1, 2, 3]) {
      const shuffled = byLevel[level].sort(() => Math.random() - 0.5);
      picked.push(...shuffled.slice(0, perLevel));
    }
    if (picked.length < size) {
      const pickedIds = new Set(picked.map(b => String(b.id)));
      picked.push(...available
        .filter(b => !pickedIds.has(String(b.id)))
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

  // Kept out of show:current on purpose — hand-typed bounties belong to the
  // pool, not to a board, so dealing a new board never loses them.
  async function persistPool() {
    await redisCmd('SET', 'show:custom-bounties', JSON.stringify(customBounties));
  }

  async function loadShow() {
    try {
      const rawPool = await redisCmd('GET', 'show:custom-bounties');
      if (rawPool) {
        const parsed = JSON.parse(rawPool);
        if (Array.isArray(parsed)) customBounties = parsed;
        console.log(`Restored ${customBounties.length} custom bounties`);
      }
    } catch (e) {
      console.error('Error restoring custom bounties:', e.message);
    }
    let restored = false;
    try {
      const raw = await redisCmd('GET', 'show:current');
      if (raw) {
        show = JSON.parse(raw);
        show.config = { ...DEFAULTS, ...(show.config || {}) };
        show.players = show.players || {};
        show.log = show.log || [];
        show.totals = show.totals || { claims: 0, paidOut: 0, attempts: 0 };
        restored = true;
        console.log(`Restored bounty show: ${show.board.length} tiles, ${Object.keys(show.players).length} players`);
      }
      if (!showKey) {
        showKey = await redisCmd('GET', 'show:key');
      }
    } catch (e) {
      console.error('Error restoring show:', e.message);
    }
    // Nothing saved — re-deal now that the custom bounties are in the pool
    // (the board seeded at mount time was drawn without them).
    if (!restored) show = freshShow();
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
        config: show.config,
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
    if (prev.config) show.config = prev.config;
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
      limits: { minBoard: MIN_BOARD, maxBoard: MAX_BOARD },
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

  // Everything the control panel needs to stock the board by hand.
  function poolView() {
    const onBoard = new Set(show.board.map(t => String(t.id)));
    return {
      limits: { min: MIN_BOARD, max: MAX_BOARD },
      boardSize: show.board.length,
      pool: fullPool().map(b => ({
        id: b.id,
        title: b.title,
        description: b.description,
        level: b.level,
        custom: !!b.custom,
        onBoard: onBoard.has(String(b.id)),
      })),
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

  // ── HAND-TYPED BOUNTIES ──────────────────────────────────────────
  function cleanBountyFields({ title, description, level }) {
    const t = String(title ?? '').trim();
    if (!t) return { error: 'A title is required.' };
    const lv = parseInt(level, 10);
    return {
      fields: {
        title: t.slice(0, 120),
        description: String(description ?? '').trim().slice(0, 400),
        level: [1, 2, 3].includes(lv) ? lv : 2,
      },
    };
  }

  // `custom:` prefixed so a hand-typed bounty can never collide with an id
  // from bounties.json, and so the panel can tell the two apart.
  function nextCustomId() {
    return 'custom:' + crypto.randomBytes(5).toString('hex');
  }

  function actionAddBounty(params = {}) {
    const { error, fields } = cleanBountyFields(params);
    if (error) return { ok: false, error };

    const bounty = { id: nextCustomId(), ...fields, custom: true, createdAt: Date.now() };
    customBounties.push(bounty);
    persistPool();

    // `toBoard` (any truthy string, since Stream Deck sends query strings)
    // puts it straight into play instead of only stocking the pool.
    const wantsBoard = params.toBoard !== undefined
      && !['0', 'false', 'no', ''].includes(String(params.toBoard).toLowerCase());
    if (wantsBoard) {
      const placed = actionAddTile({ bounty: bounty.id, value: params.value });
      if (!placed.ok) return { ok: true, bounty, board: false, warning: placed.error };
      return { ok: true, bounty, board: true, boardSize: show.board.length };
    }

    logEvent({ type: 'bounty-added', bounty: bounty.title, message: 'added to the pool' });
    commit();
    return { ok: true, bounty, board: false };
  }

  function actionUpdateBounty(params = {}) {
    const target = customBounties.find(b => String(b.id) === String(params.bounty));
    if (!target) return { ok: false, error: 'Only hand-typed bounties can be edited.' };
    const { error, fields } = cleanBountyFields({
      title: params.title ?? target.title,
      description: params.description ?? target.description,
      level: params.level ?? target.level,
    });
    if (error) return { ok: false, error };

    Object.assign(target, fields);
    persistPool();

    // Keep a tile already on the board in step with the pool entry.
    const t = tile(target.id);
    if (t) {
      snapshot(`edit ${t.title}`);
      Object.assign(t, fields);
    }
    logEvent({ type: 'bounty-edited', bounty: target.title });
    commit();
    return { ok: true, bounty: target, onBoard: !!t };
  }

  function actionDeleteBounty({ bounty: bountyId } = {}) {
    const idx = customBounties.findIndex(b => String(b.id) === String(bountyId));
    if (idx === -1) return { ok: false, error: 'Only hand-typed bounties can be deleted.' };
    if (tile(bountyId)) {
      return { ok: false, error: 'That bounty is on the board — take it off the board first.' };
    }
    const [removed] = customBounties.splice(idx, 1);
    persistPool();
    logEvent({ type: 'bounty-deleted', bounty: removed.title, message: 'removed from the pool' });
    commit();
    return { ok: true, bounty: removed.title };
  }

  // ── BOARD SHAPE ──────────────────────────────────────────────────
  function actionAddTile({ bounty: bountyId, value } = {}) {
    const b = poolBounty(bountyId);
    if (!b) return { ok: false, error: 'No such bounty in the pool.' };
    if (tile(b.id)) return { ok: false, error: 'That bounty is already on the board.' };
    if (show.board.length >= MAX_BOARD) return { ok: false, error: `The board is full (${MAX_BOARD} tiles).` };

    const parsed = parseInt(value, 10);
    const startAt = Number.isFinite(parsed) && parsed >= 0 ? parsed : show.config.startingValue;

    snapshot(`add ${b.title} to the board`);
    show.board.push(makeTile(b, startAt));
    show.config.boardSize = show.board.length;
    logEvent({ type: 'add-tile', bounty: b.title, value: startAt });
    commit();
    return { ok: true, bounty: b.title, boardSize: show.board.length };
  }

  function actionRemoveTile({ bounty: bountyId } = {}) {
    const t = tile(bountyId);
    if (!t) return { ok: false, error: 'That bounty is not on the board.' };
    if (t.status === 'claimed') return { ok: false, error: `Claimed by ${t.claimedBy} — leave it up.` };
    if (show.active && String(show.active.bountyId) === String(t.id)) {
      return { ok: false, error: 'That bounty is in play right now.' };
    }
    if (show.board.length <= MIN_BOARD) return { ok: false, error: 'The board needs at least one tile.' };

    snapshot(`remove ${t.title} from the board`);
    show.board = show.board.filter(x => String(x.id) !== String(t.id));
    show.config.boardSize = show.board.length;
    logEvent({ type: 'remove-tile', bounty: t.title });
    commit();
    return { ok: true, bounty: t.title, boardSize: show.board.length };
  }

  // Resize the live board without re-dealing it: growing draws fresh
  // bounties, shrinking drops open tiles from the end. Claimed tiles and
  // whatever is in play right now are never touched.
  function actionSetBoardSize({ size } = {}) {
    const target = parseInt(size, 10);
    if (!Number.isFinite(target) || target < MIN_BOARD || target > MAX_BOARD) {
      return { ok: false, error: `Board size must be between ${MIN_BOARD} and ${MAX_BOARD}.` };
    }

    const current = show.board.length;
    if (target === current) {
      show.config.boardSize = target;
      commit();
      return { ok: true, boardSize: current, message: 'Board already that size.' };
    }

    if (target > current) {
      const fresh = drawBoard(target - current, show.board.map(t => t.id));
      if (!fresh.length) return { ok: false, error: 'No unused bounties left in the pool.' };
      snapshot(`board size ${current} → ${current + fresh.length}`);
      show.board.push(...fresh.map(b => makeTile(b, show.config.startingValue)));
    } else {
      const protectedTile = t => t.status === 'claimed'
        || (show.active && String(show.active.bountyId) === String(t.id));
      const droppable = show.board.filter(t => !protectedTile(t));
      if (!droppable.length) return { ok: false, error: 'Every remaining tile is claimed or in play.' };

      // Newest tiles come off first — those are the ones just added.
      const dropIds = new Set(droppable.slice(-(current - target)).map(t => String(t.id)));
      snapshot(`board size ${current} → ${current - dropIds.size}`);
      show.board = show.board.filter(t => !dropIds.has(String(t.id)));
    }

    const landed = show.board.length;
    show.config.boardSize = landed;
    logEvent({ type: 'board-size', message: `Board resized: ${current} → ${landed} tiles` });
    commit();
    return {
      ok: true,
      boardSize: landed,
      ...(landed !== target ? { message: `Stopped at ${landed} — claimed or in-play tiles stay up.` } : {}),
    };
  }

  function actionNewBoard({ players: playersMode, boardSize, startingValue, increment } = {}) {
    snapshot('new board');
    const config = {
      ...show.config,
      ...(boardSize ? { boardSize: Math.min(MAX_BOARD, Math.max(MIN_BOARD, parseInt(boardSize, 10) || DEFAULTS.boardSize)) } : {}),
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

  // Pool + board shape
  action('pool', () => ({ ok: true, ...poolView() }));
  action('add-bounty', actionAddBounty);
  action('update-bounty', actionUpdateBounty);
  action('delete-bounty', actionDeleteBounty);
  action('add-tile', actionAddTile);
  action('remove-tile', actionRemoveTile);
  action('board-size', actionSetBoardSize);

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
