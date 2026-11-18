// Regression tests for B1: authentication must fail closed.
//
// Baseline bug (commit e043b7d): in app.ts, createApp() computed
//   authorized = (req) => token === '' || req.headers.authorization === `Bearer ${token}`
// so when MAKEFUN_SHOP_TOKEN was not set, EVERY request to a protected route
// was authorized. The fix makes an empty/unset token authorize nothing.
//
// Run from the repo root:
//   npm test
// (which runs: node --experimental-strip-types --test tests/auth.test.mjs)
//
// Each case boots a fresh createApp() server on an ephemeral port, because
// createApp() reads MAKEFUN_SHOP_TOKEN from the environment at build time.
// The protected probe route is GET /api/v3/user: authorized -> 200,
// unauthorized -> 401 {"message":"Bad credentials"} (the same rejection used
// by every protected surface in app.ts). GET /healthz is public by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.ts';

const DUMMY_TOKEN = 'dummy-test-token-not-a-real-secret';
const PROTECTED_PATH = '/api/v3/user';

async function withServer(tokenValue, fn) {
  if (tokenValue === undefined) delete process.env.MAKEFUN_SHOP_TOKEN;
  else process.env.MAKEFUN_SHOP_TOKEN = tokenValue;
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MAKEFUN_SHOP_TOKEN;
  }
}

async function get(base, path, authorization) {
  const headers = authorization === undefined ? {} : { authorization };
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.text() };
}

test('B1 case 1: token unset + no Authorization header -> protected route rejected 401', async () => {
  await withServer(undefined, async (base) => {
    const res = await get(base, PROTECTED_PATH);
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.body}`);
    assert.match(res.body, /Bad credentials/);
  });
});

test('B1 case 1b: token set to empty string + no Authorization header -> protected route rejected 401', async () => {
  await withServer('', async (base) => {
    const res = await get(base, PROTECTED_PATH);
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.body}`);
    assert.match(res.body, /Bad credentials/);
  });
});

test('B1 case 2: token set + wrong bearer -> protected route rejected 401', async () => {
  await withServer(DUMMY_TOKEN, async (base) => {
    const res = await get(base, PROTECTED_PATH, 'Bearer wrong-token');
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.body}`);
    assert.match(res.body, /Bad credentials/);
  });
});

test('B1 case 3: token set + correct bearer -> protected route passes auth (200)', async () => {
  await withServer(DUMMY_TOKEN, async (base) => {
    const res = await get(base, PROTECTED_PATH, `Bearer ${DUMMY_TOKEN}`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
  });
});

test('B1 case 4: /healthz stays public (200) with token unset and with token set, no header', async () => {
  await withServer(undefined, async (base) => {
    const res = await get(base, '/healthz');
    assert.equal(res.status, 200, `unset token: expected 200, got ${res.status}`);
  });
  await withServer(DUMMY_TOKEN, async (base) => {
    const res = await get(base, '/healthz');
    assert.equal(res.status, 200, `set token: expected 200, got ${res.status}`);
  });
});
