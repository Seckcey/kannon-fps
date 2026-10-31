# Deployment

Kannon Arena runs on the user-authorized Coastline Hyper-V Linux VM. The repository is at `/srv/8west/apps/kannon-fps`, with a dedicated `kannon-arena` Compose project. Other applications and their storage are unchanged. No paid service was provisioned. The [release record](RELEASE.md) identifies each verified implementation and its evidence; `/health` reports the exact running build and its `worldVersion` (`kannon-town-v3` for the first-person game in this checkout).

## Cloudflare route

Configure the existing host's Cloudflare Tunnel with:

| Field | Value |
| --- | --- |
| Public hostname | `kpop.8westventures.com` |
| Service type | **HTTP** |
| Service URL | **`127.0.0.1:14350`** |

The complete origin is `http://127.0.0.1:14350`. Cloudflared runs in the host network. The game intentionally binds only to loopback; no inbound firewall opening is needed for this tunnel layout. Forward `/`, `/api`, assets and `/ws` to the same service. The production override explicitly allows the browser origin `https://kpop.8westventures.com`.

Every request through the tunnel reaches Node from one local address, so the production override also sets `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`. Cloudflare writes that header with each visitor's address and replaces any value a visitor sends, so the server's rate limits apply per player instead of to everyone at once. This is safe only because the published port is bound to host loopback, so visitors can reach it only through cloudflared.

Players use **https://kpop.8westventures.com** without an explicit port. The user configured Cloudflare routing; public HTTPS, the built client and WSS transport have been verified on earlier releases. Physical-device and two-household acceptance remain pending.

## Coastline operation

The ignored root `.env` contains the exact `KANNON_VERSION` source commit, `PORT=14350` and `BIND_ADDRESS=127.0.0.1`. It may also contain `WS_COMPRESSION=1` to turn on WebSocket compression (see the settings table). Always pass it explicitly because the Compose files live in `deploy/`:

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

Verify `/health` reports that revision and `worldVersion`, and that the container becomes healthy. Updates end active matches. When `worldVersion` changes, as it does for the first-person release (`kannon-town-v3`), pages left open from the previous release are told to refresh and cannot start a match or send input until they do; ask players to refresh. Retain the previous image for rollback and keep the existing `kannon-arena_arena-data` volume. To roll back code, restore the previous checkout and `KANNON_VERSION`, then run the same scoped `up` command with the retained image. Do not restore or remove player data just to revert code. The first-person release did not change the SQLite store, so rolling back to the retained image keeps using the same volume.

Use a separate checkout, Compose project, volume and loopback port for test copies on Coastline, run them on demand with synthetic data, and stop them after use. Never mount the production volume into a test copy.

The container has a 512 MiB memory limit, one CPU, 128 PIDs, rotating logs and an `unless-stopped` restart policy. Measured on the previous build (the third-person game, before per-viewer snapshots and the first-person effects): an isolated eight-player Linux test under the same CPU and memory limits sustained the intended 30 Hz simulation and 15 Hz snapshots for 60 seconds, including reconnect recovery. The app and load generator shared those limits. The simulation and snapshot rates are unchanged, but no equivalent load test of the first-person build is recorded yet, and this does not establish capacity for multiple concurrent rooms or physical-device and wide-area performance. See [release verification](RELEASE.md) for measurements.

## One server and origin

Host the built client and game server together using Node.js 24+ or the container. An HTTPS reverse proxy should preserve Host, Upgrade and Connection headers to `/ws` and support long-lived sockets. Static-only hosting cannot run these matches. Blender and a GPU are not required on the server; browsers render the exported models.

The server's rate limits count requests per client address. By default that is the TCP peer address, and forwarding headers such as `X-Forwarded-For` are ignored because clients can forge them. Behind a reverse proxy every player shares the proxy's address and therefore one set of limits: a few busy visitors can then block everyone from joining. If the proxy writes the real client address into a header that clients cannot set, name that header in `TRUSTED_CLIENT_IP_HEADER`. Leave it unset when players connect to the server directly, or when the server can be reached without passing through that proxy. Either way the proxy may add its own per-client limits.

```powershell
docker compose -f deploy/compose.yml up --build -d
node deploy/smoke.mjs http://127.0.0.1:3001
```

The container runs as `node`, with a read-only root, `/tmp` scratch space, dropped capabilities and a persistent `arena-data` volume at `/app/data`. The host port defaults to loopback for an approved HTTPS proxy. Configure `BIND_ADDRESS` and `PORT` deliberately if using another host layout. Never expose the development server as production.

The `/health` endpoint and smoke script verify health, the production bundle, the public directory, WebSocket transport and anonymous-room rejection without creating a player or awarding scores.

| Environment | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` / Docker `0.0.0.0` | Listen address |
| `PORT` | `3001` | HTTP/WebSocket port |
| `DATA_DIR` | `data` / Docker `/app/data` | Database directory |
| `DB_PATH` | `DATA_DIR/kannon.sqlite` | Exact database override |
| `ALLOWED_ORIGINS` | empty | Optional comma-separated exact origins |
| `WS_COMPRESSION` | off | Set to exactly `1` to turn on WebSocket permessage-deflate. Any other value, including `true`, leaves it off. An eight-player snapshot drops from about 5.5 KB to under 0.5 KB. Leave it off until it has been checked on real iPhones. |
| `TRUSTED_CLIENT_IP_HEADER` | unset | Name of a request header that carries the real client address, used for rate limits. `cf-connecting-ip` behind Cloudflare Tunnel (set by `deploy/coastline.compose.yml`). Leave unset when the server is exposed directly. |
| `GAME_BUILD_SHA` | `development` / the image's `BUILD_REVISION` | Revision that `/health` reports; the Dockerfile sets it |

`deploy/compose.yml` passes `WS_COMPRESSION` and `TRUSTED_CLIENT_IP_HEADER` into the container from the shell or the `--env-file`, alongside `ALLOWED_ORIGINS`; a value set only in `.env` reaches the server because of that pass-through. Same-origin hosting needs no origin override. Do not use a wildcard. Capacity must be sized from measured match load; local tests do not establish production capacity.

## Backup and recovery

The database contains private profiles, hashed keys, crew memberships and invitations, and results. Never commit it or serve it publicly. For a simple consistent backup, stop only this game's instance in a maintenance window, copy the entire data volume and restart it. Copying only the SQLite main file while running can omit WAL writes; online backups should use SQLite's backup mechanism.

Restore to an isolated instance first. Preserve current data as rollback state, restore a complete known-good backup and start the tested release. Never reuse another application's database. Server restarts discard active rooms.

## Remote acceptance

Verify the deployed commit and `worldVersion`, HTTPS/WSS, the bundle and the three model downloads (operator, weapons and the town build for each device), private room and crew joining, and the actual device controls. On a desktop and a real phone, check:

- the first-person view: your hands and weapon, aiming down the sights, the Heron 7 scope, and other players drawn as soldiers;
- choosing a class, building a Custom class, and a change during a match taking effect at the next spawn;
- sprint, dash, crouch, slide, jump and vault, firing, reloading, swapping, the frag grenade and the knife on both devices;
- health refilling after a few seconds out of combat, the 1.5-second spawn protection, and respawns;
- a Free-for-all match and a Team Deathmatch match: teams, no friendly damage, the team score and the team result;
- earning and using Recon Sweep, Mortar Volley (picking a spot on the map) and Attack Drone;
- finishing a match, consistent scores and results on both devices, and rematch.

Complete an eligible ranked result and confirm it appears exactly once in history and both periods. Confirm practice and abandoned games do not count, outsiders cannot view crew standings, and brief disconnect, restart and expired-invite states are clear. Test on two separate internet connections and record real frame rates and latency before calling remote or mobile play accepted.
