// The game server for scripts/phone-fit/verify.mjs: a shorter match, and rewards always in hand, so one
// scripted match reaches every screen. Never used outside that check.
const root = new URL('../../', import.meta.url);
const { RULES } = await import(new URL('shared/protocol.ts', root).href);
RULES.matchSeconds = Number(process.env.MATCH_SECONDS ?? 80);
const { MatchEngine } = await import(new URL('server/engine.ts', root).href);
const rewards = ['recon', 'mortar', 'drone'];
const step = MatchEngine.prototype.step;
MatchEngine.prototype.step = function (now: number, dt: number) {
  for (const player of this.players.values()) if (!player.bot && player.rewards.length < rewards.length) player.rewards = [...rewards];
  return step.call(this, now, dt);
};
await import(new URL('server/index.ts', root).href);
