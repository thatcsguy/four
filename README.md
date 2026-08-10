# Four

Four is a first-playable browser multiplayer movement demo. Up to four clients automatically join one authoritative Node.js arena, predict their own movement immediately, and interpolate the other players. This milestone intentionally contains no combat, raid, account, persistence, or general-purpose physics systems.

## Architecture

- `packages/shared`: versioned Zod wire schemas, constants, and the pure deterministic 60 Hz movement step used by client prediction and server authority.
- `apps/server`: Node HTTP/WebSocket process, four-player capacity, fixed-step simulation, validation/rate limits, 20 Hz snapshots, and production static serving.
- `apps/client`: Vite/Three.js presentation, keyboard/mouse/gamepad input, fixed-rate prediction and reconciliation, remote interpolation, lifecycle cleanup, and diagnostics.

Clients send normalized world-space XZ intent plus held jump intent; they never send transforms. The server owns player membership and canonical movement state. Camera and animation state remain presentation-only.

## Setup and commands

Node.js 18.18 or newer and npm are required. From the repository root:

```sh
npm install
npm run dev
```

Open `http://localhost:5173`; joining is automatic. The one root development command builds the shared package once and starts Vite plus the authoritative server.

| Command | Purpose |
|---|---|
| `npm test` | Run shared simulation/protocol, client input/camera/netcode, and server integration tests. |
| `npm run typecheck` | Strictly typecheck every workspace. |
| `npm run build` | Build shared, client, and server production output. |
| `npm run smoke` | Run the four-client milestone smoke, including capacity, movement, malformed traffic, leave/reuse, and refresh. |
| `npm run smoke:production` | Build, launch the built Node entry on an ephemeral port, then verify HTTP HTML/assets and a WebSocket welcome. |
| `npm start` | Start the already-built server. Set `NODE_ENV=production` so it also serves `apps/client/dist`. |

For a production-style local run:

```sh
npm run build
NODE_ENV=production npm start
```

PowerShell uses `$env:NODE_ENV="production"; npm start`. Open `http://localhost:8080`.

## Ports and configuration

- `WS_PORT` controls the Node HTTP and WebSocket port; default `8080`.
- `VITE_PORT` controls the development browser port; default `5173`.
- `VITE_WS_URL` overrides the complete browser WebSocket URL and must use `ws:` or `wss:`.
- `VITE_WS_PORT` selects a development WebSocket port when `VITE_WS_URL` is absent.
- A production build with no WebSocket override connects back to the same host and port that served the page, including non-default `WS_PORT` values.

## Controls

| Action | Keyboard and mouse | Standard gamepad |
|---|---|---|
| Move | W/A/S/D, camera-yaw relative | Left stick |
| Jump | Space, held | Top face button |
| Orbit | Hold either primary mouse button and move | Right stick |
| Move forward | Hold both primary mouse buttons | Left stick forward |
| Zoom | Wheel, fixed 1.5 m steps | Hold left bumper + right stick vertical |
| Diagnostics | Backquote toggles the overlay | — |

Both sticks use a `0.1` deadzone. Movement sources combine before normalization, so diagonals and cardinal movement have equal speed. Pointer lock is requested while either primary mouse button is held and released after both are released; losing pointer lock or window focus clears held mouse input.

## Diagnostics and network-condition controls

The diagnostics overlay reports connection state, local player ID, server tick/snapshot sequence, RTT/jitter, pending input count and age, sent/acknowledged sequences, correction magnitude/count, control and state revisions, interpolation buffer depth/span/underruns, and resync count.

Development query parameters enable a deterministic delivery harness without changing production protocol JSON:

- `netLatency`: constant one-way delay in milliseconds (`75` models a base 150 ms RTT).
- `netJitter`: seeded `+/-` one-way jitter in milliseconds.
- `netDrop`: snapshot-only drop probability from `0` to `1`.
- `netDuplicate`: snapshot-only duplication probability from `0` to `1`.
- `netBurst`: inbound batch-release interval in milliseconds.
- `netSeed`: unsigned deterministic seed.
- `latency`: compatibility shorthand for total RTT; `latency=150` equals `netLatency=75`.

Example:

```text
http://localhost:5173/?netLatency=75&netJitter=20&netDrop=0.1&netDuplicate=0.2&netBurst=20&netSeed=2026
```

The harness preserves WebSocket ordering. Only snapshots may be dropped or duplicated; welcome, error, pong, and client input messages retain reliable delivery semantics.

## Verified tuning

Remote interpolation remains `100 ms`; local visual corrections ignore errors at or below `0.0005 m`, ease sub-`1 m` corrections over `120 ms`, and snap at `1 m` or a state revision. These values were retained after the automated 150 ms RTT scenario with `+/-20 ms` jitter, 10% snapshot loss, 20% duplication, and 20 ms bursts converged exactly with no resync and correction below the snap threshold. No visual constants were changed without evidence.

## Milestone limitations

- One in-memory arena only; refresh/reconnect creates a new identity and epoch.
- No authentication, persistence, matchmaking, deployment-platform configuration, combat, abilities, raids, art pipeline, audio, touch/mobile controls, or remapping UI.
- Flat circular arena only; there is no scenery collision or camera obstruction beyond ground-floor protection.
- Full JSON snapshots are intentionally used for this four-player milestone.
- Physical gamepad behavior depends on the browser's standard mapping and should be checked on target hardware; automated tests cover the standard mapping, deadzones, disconnect neutralization, orbit, zoom modifier, and jump button.
- The production client bundle currently triggers Vite's advisory for a chunk over 500 kB. It is functional; code splitting is deferred until measurements justify optimization.
