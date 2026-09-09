# Weapon taps and sound effects

The September 9, 2026 repair makes loadout icons select on pointer contact, including secondary fingers while the joystick, aiming pad or Fire button remains held. Keyboard and assistive click activation remain available. A delayed compatibility click cannot undo a newer weapon press. Authoritative weapon selection already interrupts healing/reloading and continues movement, jumping and held fire; this behavior is covered by an additional regression test.

The existing effects bank provides AR and shotgun shots, health/shield hit markers, shield breaks, damage, eliminations, healing, respawning, reloads and weapon changes. No ambient music was added. Audio now listens in capture phase for touch release, pointer release and click as well as presses and keys, and retries suspended or interrupted playback on the next gesture. Touch release is an activation event in the [browser user-activation model](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation). Safari's optional audio-session playback route addresses the [Web Audio silent-switch behavior](https://bugs.webkit.org/show_bug.cgi?id=237322); unsupported or rejected routing does not block normal audio, and leaving the game restores the previous route.

**Pause → Settings → Test sound effects** plays the same sound used for a health hit marker. Game volume still controls every effect, including mute at zero. Player volume preferences are preserved.

## Verification

- `npm run check`: all **186 tests** pass, plus asset validation, TypeScript and the production build. Seven new cases cover combined controls, delayed clicks, interrupted healing/reload, audio activation/recovery, output routing, volume and disposal.
- Installed Edge with native multi-touch input reproduced the old build's failure to switch while other fingers stayed down. The repaired production build selected the shotgun before its finger lifted while movement and Fire remained held, with a server-confirmed selection observed within 217 ms in this run. This is a test observation, not a latency guarantee.
- Rapid heal/shotgun presses preserved held controls; releasing the final fingers cleared movement and fire. Portrait also accepted a weapon press while other fingers continued movement and aiming. Landscape 852×393 and portrait 390×844 rendered without page errors or horizontal overflow.
- Browser audio analysis measured nonzero samples from gameplay effects and the hit-marker test. Zero volume produced silence. A deliberate Test sound effects tap resumed a suspended context, produced audio and reused the existing context.
- Browser emulation and waveform measurements do not establish physical iPhone speaker output, silent-switch behavior or hardware performance. After refreshing the live game, verify those on the player's device using the sound-test button and a moving shotgun switch.

The existing large JavaScript chunk warning remains. No model assets, weapon balance, protocol, database schema or player records are changed by this repair.
