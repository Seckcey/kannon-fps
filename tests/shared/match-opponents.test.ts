import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMatchOpponents, type Team } from '../../shared/protocol.js';

const player = (team?: Team, connected = true, bot = false) => ({ connected, bot, ...(team ? { team } : {}) });

test('a round goes on while a connected person has someone connected to play against', () => {
  assert.equal(hasMatchOpponents([player(), player()]), true);
  assert.equal(hasMatchOpponents([player(), player(undefined, true, true)]), true, 'An AI rival is an opponent.');
  assert.equal(hasMatchOpponents([player(), player(undefined, false)]), false, 'A disconnected rival is not.');
  assert.equal(hasMatchOpponents([player(undefined, true, true), player(undefined, true, true)]), false, 'Bots alone do not play.');
});

test('team deathmatch also needs someone connected on both sides', () => {
  const lopsided = [player('teal'), player('teal'), player('gold', false)];
  assert.equal(hasMatchOpponents(lopsided), true, 'Free-for-all rules (the default) ignore teams.');
  assert.equal(hasMatchOpponents(lopsided, 'tdm'), false, 'Two teammates with nobody left to fight.');
  assert.equal(hasMatchOpponents([player('teal'), player('teal'), player('gold', true, true)], 'tdm'), true, 'A bot keeps the other side alive.');
  assert.equal(hasMatchOpponents([player('teal'), player('gold')], 'tdm'), true);
  assert.equal(hasMatchOpponents([player('teal'), player('teal')], 'ffa'), true);
});
