# Authoritative Multiplayer Netcode Guide

This document is a generic implementation blueprint for a real-time multiplayer game with:

- a server-authoritative simulation;
- immediate local client-side prediction;
- reconciliation by restoring server state and replaying unacknowledged inputs;
- interpolation of remote players;
- server-controlled player behavior such as forced movement, movement locks, stuns, teleports, and other temporary control restrictions.

The examples use TypeScript-like pseudocode, but the design is transport-, engine-, and genre-independent. It can be used with WebSockets, Socket.IO, WebTransport, UDP-based transports, or an engine networking layer.

The central rule is:

> Clients predict presentation and local intent. The server owns canonical game state and every contested outcome.

## 1. Authority boundaries

The server owns:

- player membership and session identity;
- canonical position, velocity, rotation, and movement mode;
- collision and world-bound validation;
- whether an input is legal;
- forced movement and loss-of-control state;
- abilities, cooldowns, resources, damage, and interactions;
- any state or action that affects another player;
- match state and persistent rewards.

The client owns:

- collecting local input;
- predicting permitted local movement immediately;
- rendering and visual correction smoothing;
- interpolating remote entities;
- presentation-only effects, audio, camera behavior, and user interface.

A client sends intent, never truth. For example, it sends “move northeast” or “attempt action 2,” not “my position is now (20, 40)” or “the target took 10 damage.”

## 2. Timing model

Use independent rates for simulation, command production, snapshots, and rendering.

A practical starting configuration is:

| System | Example rate | Purpose |
|---|---:|---|
| Server simulation | 60 Hz | Advance authoritative state with a fixed delta |
| Client command production | 60 Hz | Produce deterministic input commands independently of rendering |
| Snapshot broadcast | 20 Hz | Replicate authoritative state without sending every server tick |
| Client rendering | Display rate | Present predicted and interpolated state smoothly |

These rates are configuration choices, not protocol assumptions. The important rules are:

1. Authoritative simulation uses a fixed delta.
2. Client command production does not depend on render frame rate.
3. Clients do not choose how much authoritative time an input advances.
4. Network snapshots may be less frequent than simulation ticks.

Use an accumulator for fixed-step simulation. Limit catch-up work after a long stall so one delayed frame cannot create an unbounded spiral of simulation steps.

## 3. Shared deterministic simulation

Put predicted movement and other replayed rules in a pure shared module that can run on both client and server:

```ts
nextState = stepPredictedState(previousState, input, fixedDelta, context);
```

The step function must not read:

- wall-clock time;
- rendering state;
- DOM or engine input APIs;
- uncontrolled global randomness;
- mutable singleton state.

Pass all required information explicitly. If predicted behavior requires randomness, use a seeded generator and include its state in reconciliation snapshots.

Only code that is actually predicted must be shared. Server-only decisions, such as damage or contested interactions, do not need to run on the client. Keeping the prediction surface small makes correctness and security easier to maintain.

## 4. Core protocol types

Use shared, versioned, runtime-validated schemas. Representative types are:

```ts
type Sequence = number;
type Tick = number;

interface InputCommand {
  sessionEpoch: string;
  seq: Sequence;
  clientTick: Tick;
  moveX: number;       // normalized and bounded
  moveY: number;
  look?: number;
  actions: number;     // bitset, IDs, or another explicit action representation
}

interface AuthoritativePlayerState {
  id: string;
  position: Vec;
  velocity: Vec;
  rotation: number;
  control: ControlState;
  lastProcessedInput: Sequence;
}

interface WorldSnapshot {
  protocolVersion: number;
  sessionEpoch: string;
  snapshotSeq: number;
  serverTick: Tick;
  players: AuthoritativePlayerState[];
  entities: SerializedEntityState[];
}
```

Use integers for sequence and tick identifiers within a documented safe range. Define wraparound behavior if a session can last long enough to reach the range limit.

## 5. Input command production

The client continuously samples device state, but emits commands on a fixed command clock.

For each command step:

1. Read the latest held movement state.
2. Capture edge-triggered actions that occurred since the previous command.
3. Normalize and bound analog values.
4. Assign the next sequence number.
5. Predict the command locally if the current authoritative control state permits it.
6. Store the exact command in the pending-input queue.
7. Send it to the server.

```ts
function produceCommand(): void {
  const command = {
    sessionEpoch,
    seq: ++nextInputSequence,
    clientTick: ++clientTick,
    ...sampleIntent(),
  };

  pendingInputs.push(command);
  predictedState = stepPredictedState(
    predictedState,
    command,
    FIXED_DELTA,
    predictionContext,
  );
  transport.send(command);
}
```

Store the exact sent command. Do not reconstruct historical commands from current key state during reconciliation.

For a lossy or unordered transport, send a small amount of recent input redundancy. For a reliable ordered transport, redundancy is normally unnecessary, but head-of-line blocking must be considered when choosing the transport.

## 6. Server input validation and processing

At the network boundary, validate:

- session and player ownership;
- message type and protocol version;
- message size;
- sequence range and ordering;
- movement vector range;
- allowed action identifiers;
- input rate and queue size.

Discard duplicates. Reject or resynchronize on impossible gaps according to a documented policy. Never allocate an unbounded queue because a client continues sending faster than the server consumes.

At each server tick, choose the applicable input command for each player and advance exactly one fixed simulation step. Do not advance authoritative time once per message received.

```ts
function serverTick(): void {
  for (const player of players) {
    const command = player.inputBuffer.commandForTick(serverTickNumber);
    const safeCommand = command ?? fallbackInputFor(player);

    player.state = stepAuthoritativePlayer(
      player.state,
      safeCommand,
      FIXED_DELTA,
      authoritativeContext,
    );

    if (command) {
      player.lastProcessedInput = command.seq;
    }
  }

  stepServerOwnedSystems(FIXED_DELTA);
  serverTickNumber++;
}
```

The fallback rule must be explicit. A common policy is to repeat the latest held movement briefly and then use neutral input after a timeout. This tolerates short gaps without allowing a delayed release command to move a player forever.

An input can be consumed and acknowledged even when it produces no movement. This is necessary while the server has restricted player control; otherwise acknowledgements and the client prediction queue can stall.

`lastProcessedInput` should mean the highest contiguous sequence whose outcome is represented in the snapshot. Do not acknowledge an input before its corresponding simulation step is reflected in authoritative state.

## 7. Client-side prediction

Maintain separate states for simulation and presentation:

- **Predicted state:** used for future local simulation and reconciliation.
- **Rendered state:** may smoothly approach predicted state to hide small corrections.

Never feed a smoothed render transform back into prediction.

Prediction should cover only rules needed for immediate local responsiveness. Movement is the usual minimum. An action may show an immediate visual startup, but its success and gameplay result remain server-authoritative.

The client may predict only the degrees of freedom allowed by the latest authoritative `ControlState`. For example, it must not apply normal locomotion while the server has put the player into forced motion.

## 8. Reconciliation

Each player record in a snapshot includes the highest input sequence processed by the server. On receipt of a valid, newer snapshot:

1. Find the local authoritative player state.
2. Remove pending inputs whose sequence is at or below `lastProcessedInput`.
3. Restore every future-affecting predicted field from the server state.
4. Reapply the current authoritative control state.
5. Replay remaining pending inputs in original sequence order.
6. Store the result as the new predicted state.
7. Correct the rendered state using the project’s visual correction policy.

```ts
function reconcile(serverState: AuthoritativePlayerState): void {
  pendingInputs = pendingInputs.filter(
    input => input.seq > serverState.lastProcessedInput,
  );

  let replayState = copyPredictedFields(serverState);

  for (const input of pendingInputs) {
    replayState = stepPredictedState(
      replayState,
      input,
      FIXED_DELTA,
      predictionContext,
    );
  }

  predictedState = replayState;
}
```

The key invariant is:

```text
simulate(all commands continuously)
  == restore(state after acknowledged commands)
     + replay(unacknowledged commands)
```

### State completeness

If omitting a field can make the next predicted step produce a different result, that field must be restored during reconciliation.

Depending on the game, this may include:

- position and velocity;
- grounded or movement-mode state;
- acceleration and external impulses;
- rotation and target rotation;
- jump or dash momentum;
- movement speed modifiers;
- forced-movement trajectory state;
- cooldown or cast state for predicted actions;
- deterministic random state.

Restoring only position is rarely sufficient once movement becomes more complex.

### Visual correction

Correct the simulation immediately. Presentation can handle the difference separately:

- tiny errors may be ignored visually;
- small errors may be eased out over a short interval;
- large errors, teleports, respawns, or mode changes should snap;
- persistent corrections should emit diagnostics rather than being hidden indefinitely.

## 9. Generic server control of a player

Game-specific statuses should not be embedded in the networking layer. Represent their networking effect as a generic authoritative control policy.

```ts
type ControlMode =
  | "normal"
  | "restricted"
  | "forcedMotion"
  | "disabled";

interface ControlPermissions {
  allowMove: boolean;
  allowLook: boolean;
  allowActions: boolean;
}

interface ControlState {
  mode: ControlMode;
  revision: number;
  permissions: ControlPermissions;
  startedAtTick: Tick;
  endsAtTick?: Tick;
  forcedMotion?: ForcedMotionState;
}
```

The game layer decides why the restriction exists. The netcode only needs to know its authoritative consequences. Examples include:

- movement disabled while looking or actions remain enabled;
- all player intent disabled;
- movement speed or direction constrained;
- server-authored displacement temporarily replacing normal locomotion.

Use a monotonically increasing `revision` or another stable transition identifier. It lets clients distinguish a newly applied control state from an older state with the same mode.

The server always consumes and acknowledges input during restricted control. It applies only the permitted components. The client follows the same permission policy during prediction, while accepting that the server can correct an out-of-date local assumption.

### Control-state transitions

Treat transitions as authoritative state changes:

```text
normal -> restricted -> normal
normal -> forcedMotion -> normal
any mode -> disabled -> normal
any mode -> teleport/reset -> resulting mode
```

Do not encode these transitions by merely stopping snapshot updates. The snapshot must explicitly describe the active mode and all state required to simulate or render it.

If multiple gameplay effects overlap, the server game layer combines them into one effective control policy. Define deterministic precedence, such as:

1. session removal or death-like disabled state;
2. teleport or authoritative reset;
3. forced motion;
4. complete input restriction;
5. partial restrictions and movement modifiers;
6. normal control.

The exact order is game-specific, but it must be server-owned, deterministic, and tested.

## 10. Forced movement

Forced movement is authoritative movement generated by the server rather than ordinary player intent. It should be represented as state, not as a stream of unexplained position corrections.

Two common implementations are valid.

### Simulation-driven forced movement

The snapshot contains an external velocity, impulse, target, or controller parameters. Client and server step the same pure forced-movement function on fixed ticks.

Use this when forced motion interacts continuously with collision, gravity, steering, or other simulation systems.

### Trajectory-driven forced movement

The server defines a trajectory:

```ts
interface ForcedMotionState {
  id: string;
  kind: string;          // stable behavior registry key
  startTick: Tick;
  endTick: Tick;
  start: Vec;
  end?: Vec;
  initialVelocity?: Vec;
  parameters?: Record<string, number>;
}
```

Both sides evaluate the registered behavior for the applicable server tick. Never serialize executable functions.

Use this when motion follows a known curve and has limited environmental interaction.

During forced movement:

- ordinary movement input is normally ignored or selectively permitted;
- received input is still validated, consumed, and acknowledged;
- reconciliation restores the authoritative forced-motion state before replay;
- replayed commands obey the control permissions active for their simulated tick;
- completion produces an explicit authoritative state transition;
- a new forced-motion ID distinguishes a restart from an update to the current motion.

If collisions can change the result, the server resolves them. The client may predict the same collision rule, but snapshots remain canonical.

## 11. Discontinuities and authoritative resets

Some state changes should not be replayed through or visually smoothed:

- teleportation;
- respawn;
- changing maps or simulation instances;
- loading a checkpoint;
- an explicit anti-cheat correction;
- reconnecting into a new authoritative session.

Represent these with a state or simulation revision. When that revision changes, the client:

1. discards incompatible pending inputs;
2. replaces predicted state with the authoritative state;
3. clears interpolation history as needed;
4. snaps presentation;
5. begins a fresh prediction window.

## 12. Remote-player interpolation

Do not run local-input prediction for other players. Store a bounded history of authoritative samples and render them slightly in the past.

Each sample should include:

```ts
interface RemoteSample {
  serverTick: Tick;
  snapshotSeq: number;
  state: AuthoritativePlayerState;
  receivedAtLocalTime: number;
}
```

Map server ticks to the client’s monotonic clock using a continuously estimated server-time offset. Do not directly compare an unsynchronized server wall clock with a client wall clock.

Choose a presentation time behind the estimated current server time. At 20 snapshots per second, 100 milliseconds is a reasonable starting delay. Tune it using observed jitter rather than treating it as universal.

For samples on either side of presentation time:

```ts
t = clamp((renderTick - a.serverTick) / (b.serverTick - a.serverTick), 0, 1);
position = lerp(a.position, b.position, t);
rotation = lerpShortestArc(a.rotation, b.rotation, t);
```

Rules:

- discard duplicate or older snapshot sequences;
- interpolate angles using shortest-arc math;
- snap or clear history on teleport/reset revisions;
- use the nearest sample when only one side exists;
- bound extrapolation tightly or avoid it entirely;
- delete history when an entity leaves the replicated world;
- cap history by both sample count and age.

Mode changes and forced motion may require specialized presentation, but their underlying state remains authoritative.

## 13. Snapshots and events

Snapshots describe durable state. Events describe discrete occurrences.

Snapshots should include:

- snapshot sequence and server tick;
- session or match epoch;
- complete local reconciliation state;
- current control state;
- replicated remote entity state;
- revision identifiers for discontinuities.

Events should include:

- a unique event ID;
- session epoch;
- server tick;
- event type and validated payload.

Important outcomes should not be inferred solely because an object disappeared from a later snapshot. Send an explicit idempotent event or retain the resolved outcome in state long enough for clients to observe it.

For a small game, full snapshots are the simplest reliable starting point. Add delta compression, interest management, quantization, or binary serialization only after measuring actual bandwidth and CPU cost. Periodic full baselines remain useful for recovery even after deltas are introduced.

## 14. Clock and ordering model

Use different time concepts deliberately:

- **Server tick:** authoritative simulation ordering and durations.
- **Input sequence:** acknowledgement of a client’s ordered commands.
- **Snapshot sequence:** rejection of duplicate or out-of-order snapshots.
- **Session epoch:** prevents traffic from an old connection or match entering a new one.
- **Local monotonic time:** rendering, interpolation scheduling, and network metrics.

Prefer ticks for authoritative durations. If real timestamps are required, estimate clock offset and uncertainty. Never assume client and server wall clocks agree.

## 15. Connection, reconnect, and resynchronization

The connection lifecycle should include:

1. transport connection;
2. authentication or session establishment;
3. assignment of a session epoch and player identity;
4. delivery of a complete authoritative baseline;
5. normal commands and snapshots;
6. disconnect detection;
7. reconnect with an explicit resync.

On reconnect, do not blindly replay old pending movement into a new session. The safest general policy is:

1. suspend command prediction;
2. establish or resume the server session;
3. receive a complete authoritative baseline and epoch;
4. discard pending inputs belonging to an incompatible epoch;
5. reset predicted state from the baseline;
6. resume with a new command sequence or the server-approved continuation point.

Retaining and resending commands is appropriate only when the protocol explicitly supports resuming the same epoch and can prove which commands the server processed.

## 16. Security and fault containment

At minimum:

- authenticate sessions and privileged operations;
- validate every client-controlled field at runtime;
- rate-limit each message class;
- cap input queues and pending prediction queues;
- reject non-finite numbers;
- bound movement vectors, look values, and action IDs;
- discard duplicate and stale messages;
- separate transport identity from client-supplied IDs;
- use server time and fixed deltas for authoritative simulation;
- define timeout and resync behavior when acknowledgements stop;
- log impossible sequence gaps and persistent large corrections;
- ensure malformed input can affect only its sender, not the simulation loop.

Reliable transport ordering does not replace application-level validation, epochs, sequence numbers, or size limits.

## 17. Diagnostics

Expose a development overlay and structured metrics for:

- round-trip time and jitter;
- estimated packet or snapshot loss;
- server tick and latest snapshot sequence;
- pending input count and age;
- last processed input sequence;
- reconciliation correction distance and frequency;
- current control mode and revision;
- interpolation buffer depth;
- extrapolation time;
- resync count;
- server input queue depth and discarded commands.

Record enough identifiers in logs to reconstruct a problem: session epoch, player ID, server tick, snapshot sequence, input sequence, and control-state revision.

## 18. Required tests

Test the shared simulation as pure data transformations before relying on visual playtests.

### Prediction and reconciliation

- straight, diagonal, and zero movement;
- fixed-delta scaling and world bounds;
- acknowledgement removes exactly the confirmed inputs;
- restore-plus-replay matches uninterrupted simulation;
- every future-affecting state field survives serialization;
- small and large correction policies do not change simulation state;
- the pending queue is bounded when acknowledgements stop.

### Server-controlled player behavior

- restricted input is consumed and acknowledged without applying forbidden motion;
- allowed input components still work during partial restriction;
- forced movement begins and ends on the correct ticks;
- normal inputs are not incorrectly layered onto forced motion;
- overlapping restrictions resolve with deterministic precedence;
- a changed control revision is not confused with stale state;
- collision during forced movement resolves authoritatively;
- teleport/reset clears incompatible prediction and interpolation history.

### Remote interpolation

- midpoint interpolation;
- shortest-arc rotation interpolation;
- duplicate and out-of-order snapshot rejection;
- early and late presentation times;
- bounded extrapolation;
- buffer pruning and entity removal;
- reset revisions clear stale samples.

### Transport and lifecycle

- delayed, duplicated, dropped, and reordered messages where supported;
- burst delivery after a stall;
- client render-rate variation;
- server overload and limited tick catch-up;
- disconnect and reconnect into the same or a new epoch;
- stale packets from an old session;
- invalid values, excessive rates, and oversized messages.

Run the reconciliation invariant with every predicted movement mode, not only ordinary locomotion.

## 19. Recommended implementation order

1. Define shared, versioned input and snapshot schemas.
2. Implement the pure fixed-step movement simulation.
3. Build the authoritative server tick with validated input buffering.
4. Broadcast complete snapshots containing acknowledgements and ticks.
5. Render the local player directly from authoritative state first.
6. Add fixed-rate local prediction and a pending-input queue.
7. Add reconciliation by restore and replay.
8. Separate rendered transforms from predicted simulation state.
9. Add remote snapshot buffering and interpolation.
10. Add the generic authoritative `ControlState` model.
11. Add restricted control, forced movement, and discontinuous reset handling.
12. Add reconnect epochs and explicit resynchronization.
13. Build latency, jitter, duplication, and loss simulation into the test harness.
14. Add diagnostics and correction metrics.
15. Optimize serialization or snapshot strategy only after profiling.

## 20. Minimal readiness checklist

A first multiplayer playtest is ready when the game has:

- a fixed-rate authoritative server simulation;
- shared schemas and runtime validation;
- commands that express intent rather than positions;
- per-player input ordering and acknowledgement;
- fixed-rate local prediction independent of rendering;
- complete reconciliation state and restore-plus-replay;
- separate predicted and rendered transforms;
- remote interpolation with ordered snapshot buffers;
- an explicit authoritative control-state model;
- correct handling of restricted input and forced movement;
- session epochs and a baseline resync path;
- bounded buffers and message rates;
- automated reconciliation, control-state, latency, and lifecycle tests;
- correction and queue diagnostics.

The architecture remains reliable only while every predicted state transition is reproducible, every contested result is server-owned, and every loss-of-control transition is represented explicitly in authoritative state.
