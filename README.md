# Operand

A small 1v1 live arithmetic race. One player creates a room, shares `/r/<code>`, both players ready up, and the server runs a 120-second Socket.IO race with Zetamac-style default arithmetic ranges.

Live site: https://operand.uk

## Gameplay

- Addition uses `2..100 + 2..100`.
- Subtraction is addition in reverse, so results stay in `2..100`.
- Multiplication uses `2..12 × 2..100`.
- Division is multiplication in reverse, so answers stay in `2..100`.
- Correct answers add wheel weight: 1 while tied or behind and 3 while ahead.
- The weighted wheel spins once the combined weight reaches 25, provided at least 15 seconds remain.
- The player not selected by the wheel solves a negative-answer challenge to finalize the shot and earn a point. The selected player then clears a red four-digit addition problem before continuing; that penalty problem does not add to score.

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

Fly.io or Railway can host the required Node process. The included Fly configuration allows the machine to stop when idle; set `min_machines_running = 1` and disable auto-stop if instant joins matter more than idle cost.

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
