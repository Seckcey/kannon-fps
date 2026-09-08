# Delivery and validation plan

## 0. Repository foundation

Initialize the local checkout and remote main branch with a product brief and this delivery plan. This milestone does not deliver a game.

## 1. Local playable prototype

After confirming devices and delivery format, select the engine and dependencies. Build one arena with movement, aiming, firing, and a target. Add reproducible setup and build instructions, dependency lockfiles, appropriate ignore rules, and CI with the first implementation.

Acceptance: a fresh checkout can install and build successfully; the intended device can run the prototype with usable controls. Document actual frame-rate observations and device details.

## 2. Two-player match

Implement the authoritative multiplayer server, private rooms, two-player membership, health, respawning, timer, scores, and rematches.

Acceptance: two clients see consistent match state; duplicate or invalid actions cannot award extra damage or points; a third client cannot join a full room; expired invites cannot join a match. Verify score and timer agreement at match end.

## 3. Remote-play deployment

Choose hosting with explicit agreement on any charges. Deploy the client and server with encrypted connections, server-side secrets, health checks, bounded rooms, and an operational restart procedure.

Acceptance: test from two separate internet connections, not just two tabs on the same computer. Record observed latency and behavior during delay, brief disconnection, room expiry, and server restart. Verify that neither household needs router port forwarding.

## 4. Family playtest and release

Have both intended players join and complete a match, then rematch. Fix blockers and document the final play URL, controls, known limitations, deployment version, and recovery steps.

Acceptance: both players can repeat the entire flow without developer assistance. Do not mark remote play complete until this evidence exists.

## Current state

Only repository provisioning is in scope for the initial documentation commit. All playable milestones above remain pending.
