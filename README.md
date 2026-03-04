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

## Rules
- 12 unique bounties at all times across both players (no overlap, none from used pool)
- Players can refresh their pool up to the admin-configured limit per set
- 5 wrong code attempts = 5-minute lockout
- Admin sees both players' picks in real time
