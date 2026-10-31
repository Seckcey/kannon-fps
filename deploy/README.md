# Running Kannon Arena

The image runs one authoritative game server, its HTTP API, and the built browser
client on port 3001. Deploy one instance with persistent storage. Active rooms live
in memory; restarting the process ends those rooms. Player profiles, crews, and
recorded match results live in the database on the data volume.

The deployed Coastline instance uses `http://127.0.0.1:14350` for the Cloudflare
Tunnel hostname `kpop.8westventures.com`. See [Coastline operation](../docs/DEPLOYMENT.md#coastline-operation)
for the exact project and environment-file commands. The generic commands below
create the default local deployment; use the documented Coastline override when
operating that host.

## Run the container

From the repository root, with Docker Engine running:

```sh
docker compose -f deploy/compose.yml up --build -d
docker compose -f deploy/compose.yml ps
node deploy/smoke.mjs http://127.0.0.1:3001
```

The smoke command uses the repository's installed dependencies (`npm ci` first).
Open <http://localhost:3001>. The default port binds to this computer only. The
container runs as the `node` user with a read-only root filesystem; its named
`arena-data` volume and temporary directory are writable.

`BIND_ADDRESS` and `PORT` control the host-side port mapping. They do not change the
internal port. For a trusted local-network test, set `BIND_ADDRESS=0.0.0.0` in your
shell before running Compose, then use this computer's LAN address from the phone.
The host firewall must allow the chosen port. Use an HTTPS address for the final
phone and desktop acceptance test because some browser features require a secure
context.

## Internet play

Publish this service behind an HTTPS reverse proxy on a host selected for Kannon
Arena. The proxy must forward both ordinary requests and WebSocket upgrades for
`/ws` to the same server. Keep the public website, `/api`, and `/ws` on the same
origin. Set the proxy's WebSocket idle timeout above the five-minute match length
(for example, ten minutes), and allow the application heartbeat to keep the
connection open.

Preserve the browser's original `Host` header at the proxy. If your proxy replaces
it, set `ALLOWED_ORIGINS` to the game's exact HTTPS origin in the deployment
environment (comma-separated for multiple explicitly approved origins). This lets
the WebSocket origin check recognize the public site.

The server's rate limits count requests per client address, and by default that is
the address the connection comes from. Behind a proxy that is the proxy itself, so
every player would share one set of limits and a few busy visitors could stop
everyone from joining. If the proxy writes the real client address into a header
that clients cannot set, put that header's name in `TRUSTED_CLIENT_IP_HEADER`
(`cf-connecting-ip` behind Cloudflare Tunnel; the Coastline override sets it). The
server uses the first address in that header, and the connection's own address when
the header is missing or is not a valid IP address. IPv6 addresses count by their
/64 network, the block one household is given. Leave it unset when players
reach the server directly, or when the server can be reached without going through
that proxy, because a client could then pick its own value.

`WS_COMPRESSION=1` (exactly `1`) turns on WebSocket compression, which shrinks a
full room's snapshots roughly tenfold. It is off by default until it has been
checked on real iPhones.

`deploy/compose.yml` passes `ALLOWED_ORIGINS`, `WS_COMPRESSION` and
`TRUSTED_CLIENT_IP_HEADER` from your shell or `--env-file` into the container, so
set them there. Other values in an env file only fill in the Compose files (such as
`PORT`, `BIND_ADDRESS` and the image tag); they do not reach the server.

A static hosting service alone cannot run matches. Two browser tabs on one
computer do not prove play from separate homes. Before calling a release ready for
family internet play, complete the following on the actual HTTPS address:

1. Join from a desktop and a real phone using separate internet connections.
2. Create a private crew, join it by invitation, and confirm its leaderboard is
   accessible only to its members.
3. Join the same match, start it, and confirm movement and combat are visible to
   both players. On the phone in landscape, check looking and aiming, both Fire
   buttons, Aim, Crouch and slide, Jump and vault, Reload, Swap, Grenade, Knife and
   a reward button. Check that health refills a few seconds after taking damage.
4. Play one Free-for-all and one Team Deathmatch match. Change class between lives.
   Finish each match, inspect the result on both devices, then rematch.
5. Reconnect a player during a match; refresh after a completed match and check
   that the saved profile and relevant leaderboard result remain available.
6. Verify a server restart preserves stored profiles and crew membership.

The repository's CI builds this image and checks its HTTP and WebSocket entry
points. CI does not create a public host, register a domain, or perform real phone
playtesting.

## Storage and updates

Keep the named `arena-data` volume through updates. `docker compose down` preserves
it; **do not add `--volumes`** when player data should be retained. Keep backups
outside this public repository.

For a simple consistent backup, stop the arena during an agreed maintenance
window, back up the entire data volume using the host's protected backup mechanism,
and start it again. Back up the complete directory, including any SQLite write-ahead
log files. Test restoration to a separate volume before relying on a backup.

Build and run an updated image with the same Compose project name and volume. Keep
the previous image and a matching backup until the new version has passed the
internet-play checks. Rolling back application code is separate from restoring
player data; never overwrite a live volume merely to revert an image.

An update ends active matches. When `/health` reports a new `worldVersion` (the
first-person release moves to `kannon-town-v3`), ask players to refresh their open
game pages: an older page cannot start or play a match until it is refreshed. The
first-person release did not change the database, so rolling back to the previous
image keeps using the same volume.

Do not horizontally scale this first release behind a load balancer: rooms are
owned by a single process and the persistent store is SQLite. A future multi-server
release needs shared matchmaking and an explicitly designed data migration.
