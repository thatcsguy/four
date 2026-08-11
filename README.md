# Four

Four is a first-playable browser multiplayer combat demo. Up to four clients automatically join one authoritative Node.js arena, predict their own movement immediately, interpolate the other players, and fight the shared boss Gloop as Dancers.

## Architecture

- `packages/shared`: versioned Zod wire schemas, class/ability definitions, combat constants, and pure deterministic movement and combat rules shared by tests and authority boundaries.
- `apps/server`: Node HTTP/WebSocket process, four-player capacity, fixed-step movement and projectile simulation, authoritative buffs/procs/damage, validation/rate limits, 20 Hz snapshots, and production static serving.
- `apps/client`: Vite/Three.js presentation, keyboard/mouse/gamepad input, fixed-rate movement prediction and reconciliation, remote interpolation, authoritative combat presentation, lifecycle cleanup, and diagnostics.

Clients send normalized world-space XZ intent plus held jump intent; they never send transforms. Ability presses are ordered requests, not predicted outcomes. The server owns player membership, canonical movement, class assignment, readiness buffs, proc rolls, homing projectiles, boss health, and damage. Camera, animation, and projectile extrapolation remain presentation-only.

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
| Abilities | 1–4 | — |
| Orbit | Hold either primary mouse button and move | Right stick |
| Move forward | Hold both primary mouse buttons | Left stick forward |
| Zoom | Wheel, fixed 1.5 m steps | Hold left bumper + right stick vertical |
| Diagnostics | Backquote toggles the overlay | — |

Both sticks use a `0.1` deadzone. Movement sources combine before normalization, so diagonals and cardinal movement have equal speed. Pointer lock is requested while either primary mouse button is held and released after both are released; losing pointer lock or window focus clears held mouse input.

All players currently default to the Dancer class; class selection is future work. Slot 2 is always available and guarantees the readiness buff for slot 3, while independently having a 50% chance to ready slot 1. Slot 3 consumes its readiness buff and has a 50% chance to ready slot 4. Slots 1 and 4 consume their readiness buffs and deal 25 damage instead of the 10 damage dealt by slots 2 and 3. Readiness does not expire or stack. All four abilities share a server-authoritative 2.5-second global cooldown, shown as a countdown on the hotbar. Number keys trigger on fresh key-down edges, so holding one does not repeat the ability.

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
- All players currently default to Dancer; class selection and additional classes are future work.
- No per-ability cooldowns, off-global-cooldown abilities, enemy attacks, boss reset/respawn, persistence, audio, or final combat art yet.
- No authentication, matchmaking, deployment-platform configuration, raids, art pipeline, touch/mobile controls, or remapping UI.
- Flat circular arena only; there is no scenery collision or camera obstruction beyond ground-floor protection.
- Full JSON snapshots are intentionally used for this four-player milestone.
- Physical gamepad behavior depends on the browser's standard mapping and should be checked on target hardware; automated tests cover the standard mapping, deadzones, disconnect neutralization, orbit, zoom modifier, and jump button.
- The production client bundle currently triggers Vite's advisory for a chunk over 500 kB. It is functional; code splitting is deferred until measurements justify optimization.
