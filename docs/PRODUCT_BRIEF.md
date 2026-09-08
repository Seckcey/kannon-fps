# Product brief

## Purpose

Give a father and son an easy way to meet in a competitive first-person game while apart. Quick joining, responsive controls, fair matches, and an easy rematch matter more than a large feature set.

## Proposed initial scope

- Two players in an invite-only room, with no public matchmaking or stranger discovery.
- One compact arena, one weapon, clear spawn points, and readable player silhouettes.
- Movement, mouse aiming, firing, health, damage, respawning, and score tracking.
- Short timed matches with clear winner or draw results and a rematch option.
- Clear waiting, connection failure, opponent disconnected, and room expired screens.
- Stylized, non-graphic presentation without collecting a child's real name or age.

## Remote multiplayer requirements

- Both players connect to an internet-hosted match server through encrypted connections.
- A server owns room membership, validates player actions, and calculates match results.
- Private rooms use unguessable, expiring invitations and enforce a two-player limit.
- Clients receive only the state needed to play; secrets and server credentials never reach the browser.
- Latency handling, reconnect behavior, and idle-room cleanup are part of the first remote-play milestone.

## Deferred scope

Public matchmaking, rankings, accounts, purchases, in-game chat or voice, multiple weapons, additional maps, bots, and console/mobile support are outside the proposed first release. Players can use their existing call service while playing.

## Decisions before implementation

1. Confirm both players' devices and preferred controls.
2. Confirm browser delivery versus an installed game.
3. Select the rendering engine and multiplayer stack through a small technical prototype.
4. Agree on hosting and any ongoing cost before provisioning paid services.

## Success

Both players can join a private room from different homes, complete a match, see matching results, and start a rematch without developer assistance or router configuration.
