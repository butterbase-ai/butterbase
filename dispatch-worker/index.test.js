import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetScript } from './index.js';

test('frontend paths route to the app script', () => {
  assert.equal(resolveTargetScript('/index.html', 'app_x').targetScript, 'app_x');
});

test('/_do/ routes to the DO script', () => {
  assert.equal(resolveTargetScript('/_do/chat-room/r1', 'app_x').targetScript, 'app_x_do');
});

test('/_containers/{name} routes to the per-container script', () => {
  assert.equal(resolveTargetScript('/_containers/game-server/r1/play', 'app_x').targetScript, 'app_x_ctr_game-server');
  assert.equal(resolveTargetScript('/_containers/game-server', 'app_x').targetScript, 'app_x_ctr_game-server');
});

test('bad container names fall through to frontend', () => {
  assert.equal(resolveTargetScript('/_containers/Bad_Name/x', 'app_x').targetScript, 'app_x');
});
