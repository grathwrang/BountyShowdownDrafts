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

## Solo Gameshow (1 player)
A single-contestant format at **/solo** — no opponent, no join codes, one escalating prize pot.

1. Go to **/solo** → **Start a New Show** → you land on `/solo/<id>`
2. Enter the contestant's name (and tweak the money if you want), then **Deal the Bounties**
3. **6 bounties** are dealt at once, balanced two per level — that's the whole run
4. Before each game the contestant picks one from the remaining pool and locks it in
5. After the game the host calls it: **Bounty Won** or **Bounty Failed**
6. After all 6 the show ends with a full card and the total winnings

### The money
- The pot starts at **$10**
- Every **failed** bounty adds **$1** to the next bounty's pot
- A **win** banks the current pot; the pot does not go up (and by default does not reset either)
- Starting prize, per-fail increment, bounty count and reset-on-win are all configurable on the setup screen

### Host notes
- Anyone with the `/solo/<id>` link can view and drive the run — open it on both the contestant's and the host's machine
- **Host Controls** (bottom of the page) has undo-last-result, manual pot/banked overrides, pool refreshes and restart
- `GET /api/solo/<id>` returns the live run as JSON for an overlay or OBS browser source

## Rules
- 12 unique bounties at all times across both players (no overlap, none from used pool)
- Players can refresh their pool up to the admin-configured limit per set
- 5 wrong code attempts = 5-minute lockout
- Admin sees both players' picks in real time
