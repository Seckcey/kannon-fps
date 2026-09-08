# Deployment

No public host, domain, paid service, or remote production instance was provisioned. Two-household acceptance remains pending.

## One server and origin

Host the built client and game server together using Node.js 24+ or the container. An HTTPS reverse proxy should preserve Host, Upgrade, and Connection headers to `/ws`; support long-lived sockets and limit requests by trusted client address. Static-only hosting cannot run these matches. Blender/GPU are not required on the server; browsers render the exported models.

```powershell
docker compose -f deploy/compose.yml up --build -d
node deploy/smoke.mjs http://127.0.0.1:3001
```

The container runs as `node`, with a read-only root, `/tmp` scratch space, dropped capabilities, and a persistent `arena-data` volume at `/app/data`. The host port defaults to loopback for an approved HTTPS proxy. Configure `BIND_ADDRESS` and `PORT` deliberately if using another host layout. Never expose the development server as production.

The `/health` endpoint and smoke script verify health, production bundle, WebSocket transport, and anonymous-room rejection without creating a player or awarding scores.

| Environment | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` / Docker `0.0.0.0` | Listen address |
| `PORT` | `3001` | HTTP/WebSocket port |
| `DATA_DIR` | `data` / Docker `/app/data` | Database directory |
| `DB_PATH` | `DATA_DIR/kannon.sqlite` | Exact database override |
| `ALLOWED_ORIGINS` | empty | Optional comma-separated exact origins |

Same-origin hosting needs no origin override. Do not use a wildcard. Capacity must be sized from measured match load; local tests do not establish production capacity.

## Backup and recovery

The database contains private profiles, hashed keys, crew memberships/invitations, and results. Never commit it or serve it publicly. For a simple consistent backup, stop only this game's instance in a maintenance window, copy the entire data volume, and restart it. Copying only the SQLite main file while running can omit WAL writes; online backups should use SQLite's backup mechanism.

Restore to an isolated instance first. Preserve current data as rollback state, restore a complete known-good backup, and start the tested release. Never reuse another application's database. Server restarts discard active rooms.

## Remote acceptance

Verify deployed commit, HTTPS/WSS, bundle and Blender/material assets, private room/crew joining, actual device controls, consistent health/scores, healing, respawns, and rematch. Complete an eligible ranked result and confirm it appears exactly once in history and both periods. Confirm practice/abandoned games do not count, outsiders cannot view crew standings, and brief disconnect/restart/expired-invite states are clear. Test on two separate internet connections and record real frame rates/latency before calling remote/mobile play accepted.
