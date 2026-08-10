# Player Movement and Camera Reference

## Purpose

This document specifies the observable player movement and third-person camera behavior of the reference 3D simulation. It is intended to be sufficient for recreating the same feel in another engine or architecture without depending on the original implementation.

The reference experience is a direct, camera-relative movement model with:

- immediate ground movement at a constant speed;
- normalized diagonal movement;
- a single ballistic jump with horizontal momentum locked at takeoff;
- a smoothly turning avatar that faces movement input;
- a freely orbiting third-person camera with zoom, pitch limits, and floor protection;
- keyboard, mouse, and standard gamepad controls.

The player transform is the gameplay authority for movement. The camera follows that transform but does not drive or constrain it, except that the camera's horizontal heading defines the movement basis.

## 1. World and player conventions

The world is right-handed with vertical movement on the Y axis. Ground movement occurs on the XZ plane.

- **Y = 0** is the flat ground plane.
- The player's position is anchored at the feet, not at the body's center.
- The player is approximately **1.8 m** tall and **0.4 m** in radius.
- The initial player position is the center of the arena at ground level.
- A facing angle of zero points along positive Z.
- The initial camera heading makes camera-forward point along negative Z.

The camera follows a point **75% of the player height above the feet**, or **1.35 m** for the reference character. Because this follow point includes the player's current vertical position, the camera follows the player throughout a jump.

## 2. Control map

### Keyboard and mouse

| Action | Input | Behavior |
|---|---|---|
| Move forward | W | Moves along camera-forward projected onto the ground plane |
| Move backward | S | Moves opposite camera-forward |
| Strafe left | A | Moves opposite camera-right |
| Strafe right | D | Moves along camera-right |
| Mouse-forward movement | Hold left and right mouse buttons together | Adds one forward movement input |
| Jump | Space | Starts a jump while grounded |
| Orbit camera | Hold either left or right mouse button and move the mouse | Changes camera yaw and pitch |
| Zoom | Mouse wheel | Changes orbit distance in fixed increments |

Pressing either primary mouse button requests pointer lock. Pointer lock remains active until both primary buttons have been released. Mouse movement is accumulated between camera updates, then consumed and cleared once per rendered frame. The browser context menu is suppressed.

### Gamepad

| Action | Input | Behavior |
|---|---|---|
| Move | Left stick | Camera-relative movement on the ground plane |
| Orbit camera | Right stick | Changes yaw and pitch while the zoom modifier is not held |
| Zoom | Hold left bumper and move right stick vertically | Up zooms in; down zooms out |
| Jump | Top face button | Starts a jump while grounded |

Both sticks use a **0.1 deadzone threshold**. The movement stick is treated as active when either axis exceeds the threshold. Once active, its direction contributes to the combined movement direction.

## 3. Camera-relative movement basis

Movement uses the camera's yaw but completely ignores camera pitch. Looking upward, downward, or straight down never adds vertical movement and never changes ground speed.

For a camera yaw angle `yaw`, the two normalized ground-plane basis directions are:

- **forward:** `(-sin(yaw), 0, -cos(yaw))`
- **right:** `(cos(yaw), 0, -sin(yaw))`

At the initial yaw of zero, forward is negative Z and right is positive X.

Every active movement source adds to a single direction vector:

- W adds forward; S subtracts forward.
- D adds right; A subtracts right.
- The left stick adds its horizontal value along right and its inverted vertical value along forward.
- Holding both primary mouse buttons adds forward.

After all sources are combined, any nonzero result is normalized before speed is applied. This has several consequences that are part of the reference feel:

- Diagonal movement is not faster than cardinal movement.
- Multiple inputs in the same direction do not stack speed.
- Opposing inputs can partially or completely cancel.
- An analog stick outside the deadzone produces full movement speed; its magnitude does not provide analog speed control.
- Keyboard, mouse, and gamepad input may be used simultaneously and are combined before normalization.

There is no ground acceleration, deceleration, inertia, or friction. Starting, stopping, and changing direction take effect immediately at the next movement step.

## 4. Ground movement

The reference base speed is **5.0 m/s**. A sprint effect raises this by **30%**, producing **6.5 m/s** while active.

For each movement step:

1. Build and normalize the combined input direction.
2. Select the current speed modifier.
3. Convert the direction into horizontal velocity.
4. Advance X and Z by horizontal velocity multiplied by elapsed time.

The player has no general-purpose physical body in the reference behavior. Ground movement does not model mass, forces, slopes, steps, wall sliding, or collisions with scenery.

### Arena boundary

After the player moves, the XZ position is clamped to a circle of radius **18.3 m** centered on the world origin. If the position lies outside the circle, it is projected directly back to the nearest point on the circumference while preserving its radial direction.

The boundary applies to the player's position anchor rather than to the outside of the player's body. It also applies while airborne. The clamp is positional; it does not reflect, slide, or otherwise alter stored jump velocity.

## 5. Jump model

Jumping is a single, ground-gated ballistic arc.

| Parameter | Reference value |
|---|---:|
| Initial upward velocity | 8.0 m/s |
| Downward acceleration | 20.0 m/s² |
| Ground height | 0 m |
| Additional jumps while airborne | Not allowed |

At takeoff, two things are captured:

1. Vertical velocity is set to **8.0 m/s**.
2. The current horizontal input velocity is copied into a dedicated airborne velocity.

That horizontal velocity remains fixed until landing. Releasing movement, pressing another direction, rotating the camera, or gaining or losing sprint after takeoff does not change the airborne path. A stationary takeoff remains vertically stationary in XZ; a moving takeoff continues in the original world-space direction and at the takeoff speed.

Vertical integration uses the following order each step:

1. Subtract gravity multiplied by elapsed time from vertical velocity.
2. Add the resulting vertical velocity multiplied by elapsed time to player height.
3. If the feet reach or pass ground level, snap them to Y = 0, clear vertical velocity, clear airborne horizontal velocity, and return to grounded state.

In continuous-time terms, the configured values imply an apex about **1.6 m** above takeoff and a total flight time about **0.8 s**. The actual sampled arc is slightly lower and shorter because gravity is applied before position is advanced and because landing is snapped to the ground. Results therefore vary modestly with simulation step size.

Jump is checked as a held state rather than strictly as a press edge. If the jump control remains held through landing, another jump begins on the following update. A faithful recreation should retain this behavior; a revised design may deliberately require release and re-press, but that will feel different.

## 6. Facing and locomotion animation

The avatar faces the current movement input direction. The desired facing angle is derived from the normalized ground-plane input direction, with zero facing positive Z.

Facing does not snap instantly. It turns toward the desired angle along the shortest angular path at a maximum rate of **10 radians per second**. When movement input stops, the avatar keeps its last facing direction.

This facing rule follows current input, not necessarily actual velocity. During a jump, the physical horizontal path remains locked to the takeoff velocity, but live directional input may rotate the avatar toward a different direction. Releasing input in the air stops the walking pose even though horizontal travel may continue.

The reference walk presentation is intentionally simple:

- arm and leg swing is sinusoidal;
- limbs on opposite sides move in opposing phases;
- maximum swing is **0.5 radians**;
- the phase advances at **10 radians per second**;
- on becoming idle, limb rotations ease back toward zero at a rate based on **5 per second**.

These animation details are visual only and do not affect speed, collision, or jump state.

## 7. Camera model

The camera is a perspective, third-person spherical orbit around the upper-body follow point.

| Parameter | Reference value |
|---|---:|
| Vertical field of view | 60° |
| Near clipping plane | 0.1 m |
| Far clipping plane | 1000 m |
| Initial yaw | 0° |
| Initial pitch | 0.5 rad, approximately 28.65° |
| Minimum pitch | -45° |
| Maximum pitch | 90° |
| Initial orbit distance | 15 m |
| Minimum orbit distance | 3 m |
| Maximum orbit distance | 21 m |
| Minimum camera height | 0.1 m above ground |

Given an effective orbit distance `distance`, the camera offset from its follow point is:

- **X:** `distance × sin(yaw) × cos(pitch)`
- **Y:** `distance × sin(pitch)`
- **Z:** `distance × cos(yaw) × cos(pitch)`

The camera is placed at the follow point plus this offset and looks back toward the player, subject to the screen-position adjustment described below.

There is no orbit interpolation, spring arm, damping, recentering, shoulder offset, or lag. Position and orientation respond directly on each camera update.

## 8. Camera rotation and zoom

### Mouse orbit

Camera orbit is active while either primary mouse button is held.

- Horizontal mouse movement changes yaw by **0.003 radians per pixel**.
- Vertical mouse movement changes pitch by **0.003 radians per pixel**.
- Moving the pointer right decreases yaw.
- Moving the pointer down increases pitch, raising the camera toward a top-down view.
- Pitch is clamped after rotation; yaw is allowed to accumulate without wrapping.

Mouse movement recorded while neither primary button is held is discarded at the next camera update rather than applied later.

### Gamepad orbit

Without the zoom modifier, the right stick rotates the camera at up to **2.5 radians per second** at full deflection. Horizontal input decreases yaw and vertical input increases pitch. Rotation is time-scaled and pitch uses the same limits as mouse orbit.

### Zoom

Each mouse-wheel event changes the requested orbit distance by **1.5 m**, using only the wheel direction rather than the magnitude of the wheel delta.

With left bumper held, the right stick no longer rotates the camera. Its vertical axis changes requested distance at up to **15 m/s** at full deflection. Up decreases distance and down increases it.

Requested zoom is always clamped to **3-21 m**.

## 9. Floor protection and camera obstruction behavior

The camera is prevented from being placed below **Y = 0.1 m**.

When a negative pitch and the requested orbit distance would place the camera below that floor, the camera first attempts to shorten the effective distance enough to stay above it. This temporary shortening does not overwrite the requested zoom, so the original distance returns automatically when the viewing angle allows it.

The effective distance is not allowed below the normal minimum zoom. At sufficiently low angles, even the minimum distance may intersect the floor; in that case the final camera height is clamped directly to 0.1 m. The camera may therefore be closer than the requested spherical relationship or no longer exactly the nominal orbit distance from its target near this limit.

No raycast or volume cast is performed between the player and camera. Walls, props, characters, and other geometry do not shorten or reposition the camera. Only the infinite ground floor receives collision-like protection.

## 10. Character screen-position adjustment

A user setting chooses where the character appears vertically in the viewport:

- **0** places the character toward the bottom;
- **0.5** centers the character;
- **1** places the character toward the top.

The value is adjustable in increments of **0.05** and defaults to **0.5**.

This setting does not move the camera's orbit position. Instead, it shifts the point the camera looks at along the camera's screen-up direction. The world-space amount is derived from field of view and effective orbit distance:

`vertical shift = (0.5 - screen position) × 2 × distance × tan(vertical FOV / 2)`

Using projection geometry keeps the requested screen placement approximately consistent across zoom levels. The screen-up direction is constructed from the horizontal camera-right direction and the full camera-to-target view direction.

## 11. Per-frame ordering

Exact update order matters to the resulting feel. The reference frame proceeds in this order:

1. Read current input state and process gamepad button edges used by gameplay actions.
2. Advance temporary effects that may change movement speed.
3. Update player movement and jump using the camera yaw already stored from the preceding camera update.
4. Clamp the player's XZ position to the arena.
5. Advance the rest of the gameplay simulation.
6. Build the camera follow point from the player's new feet position plus the upper-body height.
7. Consume mouse movement and current right-stick input to update camera yaw, pitch, and zoom.
8. Place and aim the camera.
9. Render the frame.

Because player movement runs before camera input is applied, newly received look input affects the movement basis on the next frame. This is normally only a one-frame difference, but it should be preserved when matching the reference exactly.

The reference uses render-frame elapsed time directly for movement, jumping, turning, camera-stick rotation, and gamepad zoom. There is no fixed-step accumulator or explicit maximum elapsed-time clamp. A production recreation should normally use a fixed simulation step for stable results, while retaining the same rates and operation order.

## 12. State required to reproduce the behavior

The movement simulation needs the following state:

- feet position in world space;
- grounded or airborne state;
- current vertical velocity;
- horizontal velocity captured at takeoff;
- current facing angle and desired facing angle;
- current speed modifiers.

The local camera needs:

- yaw;
- pitch;
- requested zoom;
- target vertical screen position;
- current projection parameters;
- accumulated mouse delta and current gamepad camera input.

For a client-server game, the camera and animation phase can remain presentation-only. Gameplay simulation must agree on the normalized world-space movement intent, speed modifiers, jump state, vertical velocity, captured airborne velocity, position, and boundary rule. A practical command can carry movement intent plus jump intent; it should not treat the camera transform itself as authoritative player state.

## 13. Replication checklist

### Movement

- [ ] Feet are the position anchor and ground is Y = 0.
- [ ] Movement is derived from camera yaw only, never pitch.
- [ ] All simultaneous input sources are added before normalization.
- [ ] Any active analog movement outside the deadzone resolves to full speed.
- [ ] Cardinal and diagonal ground movement both travel at 5.0 m/s.
- [ ] Sprint raises speed to 6.5 m/s.
- [ ] Ground movement starts, stops, and redirects without acceleration.
- [ ] The circular 18.3 m boundary projects the player anchor back to its edge.

### Jumping

- [ ] Takeoff sets upward velocity to 8.0 m/s.
- [ ] Gravity is 20.0 m/s² and is applied before vertical position advances.
- [ ] Horizontal velocity is captured once at takeoff and cannot be steered in the air.
- [ ] Landing snaps feet to Y = 0 and clears airborne velocities.
- [ ] No second jump is allowed before landing.
- [ ] Holding jump through landing triggers another jump on the next update.

### Facing and presentation

- [ ] The avatar faces live movement input at up to 10 rad/s by the shortest turn.
- [ ] Airborne facing may differ from the locked airborne travel direction.
- [ ] Limb motion does not influence gameplay state.

### Camera

- [ ] The follow target is 1.35 m above the player's current feet position.
- [ ] Orbit placement uses yaw, pitch, and effective zoom with the stated spherical relationship.
- [ ] Initial pitch is 0.5 rad and initial zoom is 15 m.
- [ ] Pitch is clamped to -45° through 90°; zoom is clamped to 3-21 m.
- [ ] Mouse orbit sensitivity is 0.003 rad/pixel.
- [ ] Gamepad orbit speed is 2.5 rad/s and gamepad zoom speed is 15 m/s.
- [ ] Mouse-wheel zoom changes by 1.5 m per wheel event.
- [ ] Either primary mouse button enables orbit; both together also add forward movement.
- [ ] The camera never drops below Y = 0.1 m.
- [ ] Camera obstruction handling is limited to floor protection.
- [ ] Vertical screen placement changes the look-at point, not the orbit position.
- [ ] Camera updates after player movement and follows the completed jump position for that frame.

## 14. Deliberate extension points

The following are not present in the reference behavior and should be treated as intentional design changes if added:

- analog walk speed based on stick magnitude;
- acceleration, braking, traction, or air control;
- slopes, steps, ledges, and general environment collision;
- collision-aware camera shortening against world geometry;
- camera smoothing, spring behavior, recentering, or lock-on;
- a jump input buffer, coyote time, or release-to-rearm requirement;
- a player-radius-aware arena boundary;
- fixed-step simulation and long-frame protection.

These additions may be appropriate for a production client-server game, but they should be introduced explicitly and tested as changes to the reference feel rather than assumed to be part of it.
