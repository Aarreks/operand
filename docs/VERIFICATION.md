# Room lifecycle verification

Previously, switching rooms removed the player directly and skipped `leaveRoom`.
Empty rooms retained their generated problem sets, and a departed opponent's
round could keep running until its timer expired. Switching now follows the same
cleanup as explicit leave and disconnect: remove the member, cancel timers and
delete an empty room, or finish a surviving opponent's round with `opponent_left`.
Capacity is checked before departure, so a rejected join preserves the old room.
Same-room joins still update the name without leaving the room.

## Automated checks

Use Node 22 or newer:

```sh
npm ci
npm test
npm run bench:rooms
```

`npm test` retains arithmetic smoke checks and adds real localhost WebSocket
clients. Tests cover switching during play, repeated solo switches, same-room
rejoins, full-room rejection, disconnects and cleanup of active shot-expiry timers.
After each test, all rooms, players and timers must be gone. CI runs both the tests
and the bounded load script on pull requests and main. Neither deploys the app.

The benchmark forks its own localhost server on a random port. It starts 25
pairs (50 clients), readies a race in each room, switches each pair 20 times,
then disconnects everyone. It reports 1,100 acknowledgement samples, server
RSS and garbage-collected heap snapshots, plus remaining room/timer counts.
It exits nonzero if abandoned rooms or timers remain. `LOAD_PAIRS` (1–100)
and `LOAD_SWITCHES` (1–100) can adjust the run. Diagnostics are read-only module
exports, communicated over local child-process IPC; no public metrics route was added.

## Local measurement, 2026-10-12

Same host, Windows, Node 24.19.0, 25 pairs and 20 switches per pair. The baseline
used the parent commit's server with only the read-only diagnostics appended;
the fixed run used this branch. Both ran in separate fresh child processes.

| Measurement | Before | After |
| --- | ---: | ---: |
| Rooms after switching | 525 | 25 |
| Rooms after all disconnects | 500 | 0 |
| Round timers after disconnects | 25 | 0 |
| Heap used after disconnects, forced GC | 27,947,896 bytes | 13,151,368 bytes |
| RSS after disconnects | 113,500,160 bytes | 107,286,528 bytes |
| Acknowledgement p50 | 4.28 ms | 4.32 ms |
| Acknowledgement p95 | 6.93 ms | 6.61 ms |
| Acknowledgement p99 | 8.43 ms | 7.59 ms |

The baseline fails the benchmark's zero-abandoned-rooms assertion, as intended.
These are single-run local loopback observations, not production latency or a
capacity guarantee. They include create/join/ready acknowledgements, not sustained
answer traffic. V8 can retain allocated pages after garbage collection, so RSS
need not return to its starting value. Room/timer counts provide the deterministic
regression check; timings and memory vary by host and are not pass thresholds.

## Manual verification

1. `npm start`; open localhost:3000 in two independent browser sessions.
2. Create an invite in A, join in B, ready both, and answer a few problems.
3. Create another room in A. B should immediately see a finished round caused
   by the opponent leaving, rather than a running countdown with one player.
4. Join A's new invite from B. Ready both and confirm a new race works.
5. Close both sessions. `/health` should report `rooms: 0` on this isolated server.
   On a live server, other players may legitimately keep rooms above zero.
6. To inspect shot-timer cleanup reliably, run the dedicated integration test;
   it earns wheel weight, finalizes a shot and switches while its timer is active.

## Review and rollback

This branch has not been deployed. Review and merge when ready, then use your
existing Fly.io deployment process. The new Actions workflow only tests.
No database, external state or protocol migration is required. To undo after
merging, `git revert <merged-change-commit>` and deploy the revert. Before merging,
close the PR to discard the branch. Tests, benchmark and diagnostics can also be
kept while reverting only the `joinRoom` cleanup change; the regression checks
will then fail, demonstrating the original bug.
