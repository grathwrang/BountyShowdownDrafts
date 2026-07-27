# AoE2 Bounty Draft

## Setup
```bash
npm install
npm start
```
Then open http://localhost:3000

## How it works
1. Go to the site → **Create Session** → set refresh limit → get a link + code
2. Share the link + code with Player 2 and Admin
3. Everyone opens the link, picks their slot (Player 1 / Player 2 / Admin), enters the code
4. Once both players join, 6 bounties are drawn privately for each (12 unique, no overlap)
5. Each player secretly picks a bounty and locks in (confirmation required)
6. Once both locked in, both click "Next Game" to advance (or Admin can advance)
7. Bounties are recorded, marked used, and new ones drawn for the next game

## Stream Bounty Show (`/show`)
A single board that lives for the whole stream. The wheel picks a viewer, they take a bounty
off the board, they queue a ranked 1v1, and you call the result with three buttons.

### The loop
1. Spin the wheel (your own infrastructure) → type the winner's name in **Who's Up**
2. They pick a bounty → click that tile on the board. It goes live on the overlay.
3. They queue and play the 1v1. Then one of:
   - **Bounty Claimed** — animation plays, their name goes on the tile for the rest of the
     stream, the tile's dollar value is paid out to them.
   - **Bounty Failed** — animation plays and a FAILED stamp stays on the overlay for the rest
     of that game. They can still win the 1v1 and bank a wheel spot.
4. **Game Over** — you're asked whether they won the 1v1. The bounty (if unclaimed) gains
   **$1**, the FAILED stamp clears, and the bounty goes back on the board for someone else.

Every bounty starts at **$10**. Nothing else changes its price — only a failed attempt.

### Board setup (control panel)
The **Board Setup** panel under the board handles both the size of the board and
hand-written bounties.

**How many bounties** — type a number (1–40) or hit one of the presets and click
**Apply**. The board resizes live, no re-deal: growing draws fresh bounties from the
pool, shrinking drops the newest open tiles. Claimed tiles and whatever is in play
are never touched, so a mid-stream resize can't wipe someone's payout. Each tile
also gets an **✕** on hover to pull just that one off the board.

**Add a bounty by hand** — title, description, level and (optionally) a starting
value other than $10. Two ways to add it:
- **Add & Put on Board** — goes straight onto the board and grows it by one.
- **Add to Pool Only** — stocked for later; rerolls, resizes and new boards can draw it.

Hand-typed bounties are saved separately from the board, so they survive restarts
and dealing a new board. They're tagged **MINE** in the pool list, where they can be
edited or deleted — editing one that's already on the board updates the tile too.
The pool list also puts any of the 99 stock bounties straight onto the board with
**+ Board**.

### Pages
| URL | What it is |
| --- | --- |
| `/show` | Host control panel. Admin password login. |
| `/show/overlay` | OBS browser source, 1920x1080 transparent — active bounty card + the claimed/failed animations. `?side=left` to flip it, `?scale=0.8` to resize. |
| `/show/board` | OBS browser source, 1920x1080 — the full board with values and claimer names. `?bg=1` for a solid backdrop. |

### Stream Deck / streamer.bot
Every action answers to both GET and POST so a Stream Deck button can fire it directly. The
control panel prints ready-made URLs with the key already in them.

```
/api/show/claim?key=KEY          bounty claimed
/api/show/fail?key=KEY           bounty failed (stamp until game end)
/api/show/game-won?key=KEY       1v1 over, they won   (+$1 if unclaimed, +1 wheel spot)
/api/show/game-lost?key=KEY      1v1 over, they lost  (+$1 if unclaimed)
/api/show/undo?key=KEY           undo the last action
/api/show/select?key=KEY&player=NAME&bounty=ID
/api/show/cancel?key=KEY         wipe the current attempt, no money changes
```

Board setup answers to the same key:

```
/api/show/board-size?key=KEY&size=N            resize the live board (1–40)
/api/show/add-bounty?key=KEY&title=T&description=D&level=1|2|3[&toBoard=1][&value=N]
/api/show/update-bounty?key=KEY&bounty=ID&title=T&description=D&level=N
/api/show/delete-bounty?key=KEY&bounty=ID      hand-typed bounties only
/api/show/add-tile?key=KEY&bounty=ID[&value=N] put a pool bounty on the board
/api/show/remove-tile?key=KEY&bounty=ID        take a tile off the board
/api/show/pool?key=KEY                         the whole pool + what's on the board
```

The key comes from `SHOW_API_KEY`; if that env var is unset one is generated on first boot and
kept in Redis. Read-only endpoints need no key: `/api/show/state`, `/api/show/board`,
`/api/show/leaderboard`.

### Player database
Every name that plays is tracked: attempts, bounties claimed, fails, 1v1 wins/losses, wheel
spots and total dollars earned. `GET /api/show/leaderboard` returns the whole thing as JSON
for the external leaderboard site to pull. Player history survives dealing a new board.

## Rules
- 12 unique bounties at all times across both players (no overlap, none from used pool)
- Players can refresh their pool up to the admin-configured limit per set
- 5 wrong code attempts = 5-minute lockout
- Admin sees both players' picks in real time
