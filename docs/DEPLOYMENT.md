# Deployment

The game, including the Sunbreak Blender environment and active practice upgrade, is deployed on the user-authorized Coastline Hyper-V Linux VM. The repository is at `/srv/8west/apps/kannon-fps`, with a dedicated `kannon-arena` Compose project. Other applications and their storage are unchanged. No paid service was provisioned. The [release record](RELEASE.md) identifies the verified implementation and its evidence; `/health` reports the exact running build.

## Cloudflare route

Configure the existing host's Cloudflare Tunnel with:

| Field | Value |
| --- | --- |
| Public hostname | `kpop.8westventures.com` |
| Service type | **HTTP** |
| Service URL | **`127.0.0.1:14350`** |

The complete origin is `http://127.0.0.1:14350`. Cloudflared runs in the host network. The game intentionally binds only to loopback; no inbound firewall opening is needed for this tunnel layout. Forward `/`, `/api`, assets, and `/ws` to the same service. The production override explicitly allows the browser origin `https://kpop.8westventures.com`.

Players use **https://kpop.8westventures.com** without an explicit port. The user configured Cloudflare routing; public HTTPS, the built client, and WSS transport have been verified. Physical-device and two-household acceptance remain pending.

## Coastline operation

The ignored root `.env` contains the exact `KANNON_VERSION` source commit, `PORT=14350`, and `BIND_ADDRESS=127.0.0.1`. Always pass it explicitly because the Compose files live in `deploy/`:

```sh
ssh coastline
cd /srv/8west/apps/kannon-fps
docker compose --env-file .env -p kannon-arena -f deploy/compose.yml -f deploy/coastline.compose.yml ps
curl --fail http://127.0.0.1:14350/health
```

For a tested update, fast-forward `main`, set `KANNON_VERSION` in `.env` to the full `git rev-parse HEAD` value, then run:

```sh
docker compose --env-file .env -p kannon-arena -f deploy/compose.yml -f deploy/coastline.compose.yml build
docker compose --env-file .env -p kannon-arena -f deploy/compose.yml -f deploy/coastline.compose.yml up -d --no-build
```

Verify `/health` reports that revision and the container becomes healthy. Updates end active matches. Retain the previous image for rollback and keep the existing `kannon-arena_arena-data` volume. To roll back code, restore the previous checkout and `KANNON_VERSION`, then run the same scoped `up` command with the retained image. Do not restore or remove player data just to revert code.

The container has a 512 MiB memory limit, one CPU, 128 PIDs, rotating logs, and `unless-stopped` restart policy. An isolated eight-player Linux test under the same CPU/memory limits sustained the intended 30 Hz simulation and 15 Hz snapshots for 60 seconds, including reconnect recovery. The app and load generator shared those limits; this does not establish capacity for multiple concurrent rooms or physical-device/wide-area performance. See [release verification](RELEASE.md) for measurements.

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
