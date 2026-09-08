# Kannon FPS

A competitive first-person game for a father and son to spend time together, even when they are in different homes.

## Status

Repository provisioned. Game implementation and hosting have not started; there is no playable build yet.

- Local checkout: `C:\it\kannon-fps`
- Remote repository: https://github.com/Seckcey/kannon-fps
- Primary branch: `main`

## First playable release

Create a private match, share an invite, and play a short one-versus-one arena match from two different internet connections. The first release should include movement, aiming, one weapon, damage, respawning, a scoreboard, a match timer, and a rematch action.

Proposed direction: a desktop-browser game with keyboard and mouse controls, stylized non-graphic combat, and a hosted multiplayer server. This direction needs confirmation before implementation, especially if either player needs a controller, console, or mobile device.

The server will decide hits, health, scores, and match results so both players share the same match state. Remote play must work without either household opening router ports.

## Project documents

- [Product brief](docs/PRODUCT_BRIEF.md)
- [Delivery and validation plan](docs/DELIVERY_PLAN.md)

## Development status

No engine, dependencies, build commands, CI, hosting provider, or paid services have been configured. Choose these during implementation planning and document working setup commands alongside the first runnable build.

## Repository practices

Keep credentials, private invite links, personal information, and player data out of Git. Use small, focused changes and document how each playable milestone was verified. This repository is currently public; do not assume its contents are private.
