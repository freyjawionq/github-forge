# REVIEW B1 — Auth fail-closed (MAKEFUN_SHOP_TOKEN unset no longer authorizes everything)

Date: 2026-11-18 (WIB), under the one-editor lock recorded in the team Evernote note.
Baseline commit: `e043b7dbb346c592e8a0cd83c259f02affd1daaa`
Scope: B1 only. B2 (gitobj parser), B3 (PATCH atomicity), B4 (pagination), B5 (README), B6 (BFS) untouched.

## The bug (verified on the baseline HEAD before the fix)

In `app.ts`, `createApp()`:

```ts
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const authorized = (req) => token === '' || req.headers.authorization === `Bearer ${token}`;
```

With `MAKEFUN_SHOP_TOKEN` unset (or empty), `authorized()` returned `true` for every
request — all protected surfaces (`/api/v3/*`, `/api/graphql`, `/mcp`, git smart HTTP)
were wide open. Every protected surface rejects with the same response:
**401 `{"message":"Bad credentials"}`**. `GET /healthz` is answered before the auth
check and is public by design.

## The fix (app.ts, one expression + comment)

```ts
// Fail closed (B1): an unset/empty token authorizes nothing, never everything.
const authorized = (req) => token !== '' && req.headers.authorization === `Bearer ${token}`;
```

Behavior with a token set is unchanged (correct bearer passes, wrong bearer gets 401).
`/healthz` behavior is unchanged.

## Regression tests

`tests/auth.test.mjs` (node:test). Each case boots a fresh `createApp()` on an
ephemeral port (the token is read from the env at `createApp()` time), probes
`GET /api/v3/user` (authorized -> 200, unauthorized -> 401), and closes the server.

Run from the repo root:

```
npm test
# = node --experimental-strip-types --test tests/auth.test.mjs
```

Cases:
1. token unset + no Authorization header -> expect 401
1b. token = '' + no Authorization header -> expect 401
2. token set + wrong bearer -> expect 401
3. token set + correct bearer -> expect 200
4. `/healthz` -> 200 with token unset and with token set, no header

(The test token is a local dummy constant, not a real credential.)

## Baseline vs candidate — exact results

Command (both runs): `node --experimental-strip-types --test tests/auth.test.mjs`

Baseline (clean clone of `e043b7d` with only the test file copied in; the same result
was reproduced in the working tree before the fix):

```
exit code 1 — tests 5, pass 3, fail 2
✖ case 1:  token unset -> expected 401, got 200 (viewer user JSON returned with no credentials)
✖ case 1b: token ''    -> expected 401, got 200
✔ case 2:  wrong bearer -> 401
✔ case 3:  correct bearer -> 200
✔ case 4:  /healthz -> 200 (unset and set)
```

Candidate (after the fix):

```
exit code 0 — tests 5, pass 5, fail 0
✔ case 1, 1b, 2, 3, 4 all pass
```

## Limitations

- Only the `/api/v3/user` probe route is exercised end-to-end; the other protected
  surfaces share the same `authorized()` predicate and the same 401 rejection in
  `app.ts`, but are not individually probed by this test.
- Tests cover the auth predicate behavior over HTTP, not token provisioning: an
  operator who never sets `MAKEFUN_SHOP_TOKEN` now gets a forge that rejects all
  protected traffic (fail-closed) instead of one that accepts everything.
- No claim is made about any official/make.fun score effect.
