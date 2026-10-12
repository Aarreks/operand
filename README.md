# Operand

A small 1v1 live arithmetic race. One player creates a room, shares `/r/<code>`, both players ready up, and the server runs a 120-second Socket.IO race with Zetamac-style default arithmetic ranges.

Live site: https://operand.uk

## Gameplay

- Addition uses `2..100 + 2..100`.
- Subtraction is addition in reverse, so results stay in `2..100`.
- Multiplication uses `2..12 × 2..100`.
- Division is multiplication in reverse, so answers stay in `2..100`.
- A weighted wheel can trigger after players accumulate enough answer weight, with at least 15 seconds left in the round. The selected player's opponent solves a short negative-answer problem to finalize the shot.
- A shot plays a metal-pipe sound for both players and gives the target a four-digit addition problem. Clearing that penalty restores the original problem without adding a point.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`, create an invite, and open the copied link in another browser or private window to test the second player.

## Test

```bash
npm test
```

Real two-client room-switching and disconnect tests run in CI. For an isolated
localhost room-churn benchmark, run `npm run bench:rooms`. See
[verification and rollback instructions](docs/VERIFICATION.md) for the measured
baseline, test coverage and a manual two-browser checklist.

## Deployment note

This app needs a Node process that supports WebSockets. Static-only hosts are not enough unless you replace Socket.IO with a hosted realtime provider.

## Fly.io deployment

```bash
fly deploy
```

The included Dockerfile uses Node 22 and installs production dependencies only.
Rooms live in one process, so keep a single app machine unless room routing and
shared state are added. `fly.toml` enables automatic start/stop, which can add a
cold-start delay. Invite links use `https://operand.uk/r/<code>`.
