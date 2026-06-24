# Operand

A small 1v1 live arithmetic race. One player creates a room, shares `/r/<code>`, both players ready up, and the server runs a 120-second Socket.IO race with Zetamac-style default arithmetic ranges.

Live site: https://operand.uk

## Gameplay

- Addition uses `2..100 + 2..100`.
- Subtraction is addition in reverse, so results stay in `2..100`.
- Multiplication uses `2..12 × 2..100`.
- Division is multiplication in reverse, so answers stay in `2..100`.
- The losing player periodically gets `[X] Shoot`. Shooting plays a metal-pipe sound for both players and forces the opponent to clear a red four-digit addition problem before continuing. The red problem does not add to score.
- Gunshots have a 15-second room-wide cooldown.

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

## Deployment note

This app needs a Node process that supports WebSockets. Static-only hosts are not enough unless you replace Socket.IO with a hosted realtime provider.

## Cheap deployment

The cheapest practical setup for immediate 1v1 play is Fly.io or Railway with one tiny always-on Node instance. Avoid static-only hosting and avoid free sleeping services if you want the second player to click the link and play immediately.

### Fly.io

```bash
fly launch
fly scale memory 256
fly scale count 1
fly deploy
```

Choose the included Dockerfile when Fly asks. Keep one machine always on for the least latency, and do not use auto-stop if you want instant joins. Your invite links will look like:

```text
https://your-app.fly.dev/r/abcde
```

For shorter links, add a short custom domain in Fly and point DNS through Cloudflare:

```text
https://zeta.example.com/r/abcde
```
