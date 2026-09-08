# Ready before the round

Starting a match previously began the three-second countdown before the browser had parsed the models, prepared lighting and rendered the arena. Desktop mouse capture was disabled during that countdown. A slow scene startup could consume match time and spawn protection before the player could control their character; rematches also required capturing the mouse after combat began.

## Player experience

The host starts the match or rematch. Each player first sees their loaded arena and selects **Ready to play**. Desktop players capture the mouse with that click; touch players use the button without generating a movement or fire action. The roster shows who is ready. Everyone receives the full three-second countdown, followed by the regular five-minute round and two-second spawn protection.

While waiting, Escape, focus loss, a pause/settings menu, graphics failure or a disconnected connection revokes local readiness. Returning requires a fresh gesture. Mouse capture remains active through the countdown, but held and queued gameplay inputs are cleared. Once the countdown starts, the existing live-round behavior applies: menus and disconnects do not pause the match or grant protection.

A preparation expires after 45 seconds. Players return to the lobby with a persistent explanation and can retry. Leaving a two-person preparation cancels it without a match result. If someone has an older page open, the server asks everyone to refresh before starting; it does not put unsupported pages into an unexplained wait.

## Implementation

`start` and `rematch` enter the server's `preparing` phase. The engine resets visible health, equipment, scores and positions, while match time remains at 300 seconds and combat stays inactive. The preparation ID equals the engine's fresh round ID; world snapshots carry that ID. A readiness message belongs to that preparation and authenticated room member. Every required human must be connected and ready; practice bots are implicitly ready. New players cannot join a preparation already in progress.

The renderer separately tracks loaded assets and a successfully rendered frame of the current prepared round. The frame must contain the living, connected local player and match the requested preparation ID. This prevents a rematch from reusing the previous round's render proof. Delayed callbacks cannot admit another preparation. An intentionally hidden character during finished/dead recovery does not prevent the general loading screen from clearing.

Desktop readiness waits for actual pointer-lock confirmation rather than treating a resolved request as proof. A refused request leaves the player unready with a retry message. The input controller separates gameplay blocking from releasing the mouse, and rejects old keyboard repeats after a reset. The server independently discards all pre-play inputs, including action taps that could otherwise survive into the first live tick.

Temporary disconnections keep the original participant's place during the existing recovery grace, while removing their acknowledgment. Reconnection or replacing a tab requires readiness again. Explicit departures remove that participant; private preparation cancels if fewer than two remain. Expiry, cancellation and incompatible-page handling produce no ranked results. Finished-result replay remains idempotent.

Clients advertise `readyProtocol: 1` during `hello`. An older connected participant blocks start/rematch before mutation. Replacing a participant with an older page during preparation cancels to the lobby with the same refresh instruction. This is compatibility negotiation, not an anti-cheat assertion about the honesty of a modified client.

## Verification

The complete local check passes 155 tests, exported-asset validation, TypeScript and the production build. The focused wire tests exercise slow readiness, all eight humans, fresh countdown/protection, stale or malformed acknowledgments, early input rejection, withdrawal, timeout/retry, identity replacement, reconnect, host departure, rematches, legacy pages and unchanged leaderboard results. Client tests cover capture failure and late completion, preparation identity, focus/connection resets, retained countdown capture, fresh gestures and per-round render proof.

[Local browser evidence](verification/round-readiness-local.json) records four development groups and three production-build groups in installed Edge. These include a six-second delay before real environment parsing, a refused mouse capture followed by a successful native retry, delayed rematch world messages, real offline/online recovery, desktop and touch movement/fire, timeout/retry and an intentional parse failure with an available exit. The first in-app capture attempt did not acquire the mouse; its cause is unproven and it is not counted as capture acceptance. Separate Edge checks verify that behavior. Only the known sky precision warning appeared; application errors were absent. [Desktop readiness](art/round-ready-desktop.png) and [touch readiness](art/round-ready-touch.png) show the production build.

Release identities and deployment evidence are recorded in [Release verification](RELEASE.md). Browser emulation does not establish physical-phone performance or a two-household family match.

The Scout and environment exports, collision, movement speeds, weapon balance, match length, scoring and rating rules are unchanged. This fixes entry fairness around graphical startup; it does not establish Fortnite parity or add server rewind.
