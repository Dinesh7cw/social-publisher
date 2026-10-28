# Test report

Date: 2026-10-28
Environment: Windows 10.0.26200, Node 24.13.0, Postgres 16 (Docker), Redis 7 (Docker), RustFS (S3).

> **Scope of these results.** Everything below was executed. Nothing here is projected, estimated or
> described from intent. In particular, **no test in this report published to a real social account**,
> because no platform credentials exist in this environment. Section 5 states that plainly.

---

## 1. Summary

| Suite | Result | What it actually proves |
| --- | --- | --- |
| Unit (`tests/unit`) | **71 passed** | Crypto, status derivation, adapter request shapes, error classification |
| Integration (`tests/integration`) | **45 passed** | Real Postgres and Redis: cross-client isolation, unique constraints, publish executor, queue persistence |
| End-to-end (Playwright) | **53 passed, 2 skipped** | Every screen renders at 1440/768/390, auth guards hold, client CRUD and composer behave |
| Design inspector (taste-skill) | **0 FAIL, 0 WARN** on the login screen | Contrast, type sizes, layout measurements |
| Typecheck (`tsc --noEmit`) | **clean** | No type errors under `strict` + `noUncheckedIndexedAccess` |
| Production build | **clean** | All 38 routes compile |

The 2 skipped E2E tests are the phone-navigation test in the desktop and tablet projects, where it is
not applicable by design.

---

## 2. What each suite covers

### 2.1 Unit tests (71)

**Token encryption** (`crypto.test.ts`, 15 tests)
- Round-trips a token; produces a different ciphertext each time for the same plaintext (random IV).
- Rejects a tampered payload, a tampered auth tag, a malformed envelope, and an unknown version.
- Fails closed when the key is rotated — the old ciphertext does not silently decrypt to garbage.
- Constant-time comparison and identifier hashing behave as specified.

**Status derivation** (`domain-status.test.ts`, 15 tests)
- `PUBLISHED` is produced **only** when every target is published.
- `PARTIAL` for mixed outcomes; `FAILED` when nothing published; `PUBLISHING` while anything is in
  flight.
- Order-independent, and retry/editability rules match the state machine.

**Adapter behaviour** (`adapters.test.ts`, 22 tests)

| Behaviour | Why it matters |
| --- | --- |
| LinkedIn reads the post id from **`x-restli-id`** | The body is empty on success; reading `body.id` silently reports failure |
| LinkedIn sends both `Linkedin-Version` and `X-Restli-Protocol-Version` | Omitting either returns a 400 that looks like a malformed request |
| LinkedIn uses `urn:li:organization:` vs `urn:li:person:` by account type | Wrong URN returns a permission error |
| Instagram runs quota → container → status → publish, in that order | Publishing a not-yet-ready container fails opaquely |
| Instagram builds child containers then a parent for carousels | The carousel path is different code |
| Instagram refuses a text-only post client-side | The platform has no text-only post |
| Instagram refuses when the 24 h quota is exhausted | Saves a doomed batch |
| X counts a URL as 23 characters | X's arithmetic differs from `String.length` |
| X uploads media before creating the post | Media ids must exist first |
| Facebook passes `link` when the caption has a URL | Otherwise the preview card is lost |
| All adapters refuse video with a clear message | Video needs permissions this build does not request |

**Error classification** (`platform-http.test.ts`, 12 tests)
- 429 → transient with `Retry-After` honoured.
- 401 → auth (triggers one refresh).
- 403 → permanent with a permission message.
- 5xx → transient.
- 400 → permanent; a retry cannot fix a bad request.
- **Network failure during publish → `ambiguous`, never transient.** This is the duplicate-post hazard.
- Network failure during a read → transient.
- An unparseable 2xx during publish → ambiguous, not success.
- The token never appears in an error message.
- Redirects are not followed, so a token cannot leak to another host.

**Environment guard** (`env-guard.test.ts`, 11 tests) — see §4.

### 2.2 Integration tests (45)

These run against the real database because the properties under test only exist there.

**Cross-client isolation** (`posts.test.ts`)
- An account belonging to client B cannot be attached to client A's post.
- Media belonging to another client is refused.
- **The refusal is `NOT_FOUND`, not `FORBIDDEN`**, so the API does not confirm that another client's
  data exists.
- The same account cannot be targeted twice on one post.
- Archived clients refuse new posts.

**Database constraints**
- `unique(postId, socialAccountId)` rejects a second target for the same account.
- `unique(platform, externalId)` rejects the same page connected twice.
- `unique(postTargetId, attemptNo)` rejects a duplicate attempt row.

**Publish executor** (`publish.test.ts`, 11 tests)
- A target and its post are marked published **only after** the platform returns an id.
- **A redelivered job does not publish twice, and the platform is called exactly once.** This is
  asserted directly on the fetch call count.
- A second attempt with an already-used attempt number publishes nothing.
- 5xx → retryable and the post stays unpublished.
- 400 → permanent.
- **A network failure is recorded as `UNKNOWN`, not retryable.**
- 401 marks the account `EXPIRED` so the team is prompted to reconnect.
- An account with no stored secret is refused **without any network call**.
- The access token never reaches the attempt record.
- An audit entry is written when a post goes out.
- **Four targets with two published and two failed produce `PARTIAL`, with all four outcomes kept and
  two distinct platform ids.**

**Queue durability** (`queue.test.ts`)
- A delayed job survives closing every connection and reopening with a fresh client — the restart
  requirement, tested by actually simulating a restart.
- The job's delay and payload are intact after reconnecting.
- Enqueueing the same target and attempt twice creates one job, not two.

**Security** (`security.test.ts`)
- Passwords are argon2id, never stored in plaintext; a malformed hash reads as "wrong password" rather
  than throwing.
- Audit redaction removes tokens and secrets at any depth.
- The CSRF origin check allows the configured origin and rejects a foreign one and a missing one.
- Role capabilities are correct for both roles.
- Sessions are per-user and not shareable.

### 2.3 End-to-end (53 passed)

Across three viewports (1440×900, 768×1024, Pixel 7):

- Unauthenticated access redirects to login; the private API returns 401 with `UNAUTHENTICATED`.
- A wrong password returns one generic message (no account enumeration).
- All seven screens render with exactly one `h1` naming the screen.
- Dashboard shows all six counters, with real numbers where data exists and honest zeros elsewhere.
- Client creation works through the real dialog; search narrows the list.
- The composer explains an empty account state rather than showing a broken picker, and its submit
  button is disabled with nothing selected.
- The accounts screen states which platforms are not configured instead of hiding them.
- On a phone the sidebar folds into a menu that navigates.

### 2.4 Design checks

`lint.mjs --app`: **0 FAIL**, 6 WARN, each reviewed:
- Three shadows annotated — a focus ring (accessibility), a dialog (an overlay, which the rules allow
  to float), and an inset rule marking today in the calendar.
- Zero-padding in date formatting (a date, not an index label).
- Em-dashes in prose, reduced from 9 to 4, with the remaining ones being legitimate missing-value
  dashes.

`inspect.mjs --app` on the login screen: **0 FAIL, 0 WARN** at 1440, 768 and 390, after fixing three
real findings it caught:
1. Two contrast failures — white on `#E62F30` measured 4.36:1. Fixed by using the brand's
   `--button-primary-hover` (`#D53031`, 4.89:1) for filled buttons. The green status text was 2.09:1
   and now uses the same hue at 60% lightness (5.28:1).
2. 55% of text under 13px. Raised labels and data to 13px, keeping 12px for sublines.
3. A 33% empty first screen. Replaced the floating card with a two-column composition carrying what the
   product actually does.

Screenshots of every authenticated screen at all three widths were captured and reviewed.

---

## 3. Bugs found and fixed during testing

Recorded because they are the reason the tests exist.

| Bug | Found by | Fix |
| --- | --- | --- |
| An auth failure was recorded as `UNKNOWN` | `publish.test.ts` | Classify `ApiError` codes explicitly before the catch-all: `PLATFORM_AUTH_EXPIRED` → needs reconnect, `PLATFORM_DISABLED` → permanent |
| Registry mapped unimplemented platforms to the Facebook adapter | Code review | Removed the fallback entirely; a platform with no adapter is now impossible to publish through |
| `__Host-` cookie prefix is rejected over http in dev | Manual verification | Cookie name is environment-aware; the prefix is kept in production |
| Idempotency check queried metadata that was never written | Code review | Replaced with a dedicated `IdempotencyRecord` table and a unique key |
| Nav landmark had no accessible name | E2E mobile test | Moved `aria-label` from the wrapper to the `<nav>` |
| Dialog footer unreachable on a phone | E2E + hit-testing | Sticky header and footer inside a single scroll container |
| Missing secret produced `UNKNOWN` instead of a determinate failure | `publish.test.ts` | Explicit classification |
| A leaked `DATABASE_URL` pointed the dev server at the test database | Manual verification | Added a startup guard plus `scripts/which-db.ts` |

---

## 4. The database guard

One incident deserves its own note. An earlier shell set `DATABASE_URL` to the **test** database, and
that environment variable persisted. Every server started from that shell then used the test database,
which the integration tests truncate — producing a "wrong password" error that was really a wiped
table, and a phantom social account appearing in the composer.

Three things now prevent a recurrence:
1. `src/instrumentation.ts` runs `assertEnvironment()` at startup.
2. `checkDatabaseForEnvironment` **fails** a test run against a non-`_test` database and a production
   run against a `_test` database, and warns loudly for development.
3. `resetDatabase()` in the test harness re-checks the database name before truncating anything.

Covered by 11 unit tests.

---

## 5. What is NOT verified

This is the most important section of the report.

| Item | Status | Why |
| --- | --- | --- |
| **Publishing to a real Facebook Page** | ❌ not verified | No Meta app, no Page, no credentials in this environment |
| **Publishing to a real Instagram account** | ❌ not verified | Same, plus no professional account available |
| **Publishing to a real LinkedIn profile or organisation** | ❌ not verified | No LinkedIn app; organisation access needs manual approval that has not been requested |
| **Publishing to a real X account** | ❌ not verified | No X developer account, no credits |
| Real OAuth round-trip on any platform | ❌ not verified | Requires credentials and a public callback URL |
| Media upload against a real S3 provider | ⚠️ partially | Logic exercised against a local S3-compatible server; not against AWS/R2 |
| Video publishing | ❌ not implemented | Every adapter refuses it explicitly rather than pretending |
| Deployment to a real VPS | ❌ not done | No server available |
| TLS with a real certificate | ❌ not done | No domain |
| Backup restore | ❌ not run | Documented only |
| Load or soak testing | ❌ not done | — |
| Page Publishing Authorization (Instagram) | ❌ not testable | The API gives no way to detect PPA; documented as a manual prerequisite |

Every adapter is exercised against mocked API responses that model the documented response shapes,
including the specific quirks that break naive implementations (LinkedIn's header-only post id,
Instagram's two-step publish, X's URL character counting). That is a real level of assurance about the
code. It is **not** the same as a verified integration, and this project does not claim it is.

The UI reflects this: a platform whose credentials are absent reads "Needs credentials from an admin"
and cannot be selected as a publishing target.

---

## 6. How to reproduce

```bash
# 1. Infrastructure
docker compose up -d

# 2. Schema and the two seed clients
pnpm db:migrate
pnpm db:seed

# 3. Create and migrate the test database
docker exec cw-social-postgres psql -U cw -d postgres -c "CREATE DATABASE cw_social_test;"
DATABASE_URL="postgresql://cw:cw_dev_password@localhost:55440/cw_social_test?schema=public" pnpm prisma migrate deploy

# 4. Unit and integration tests
pnpm vitest run

# 5. Typecheck and build
pnpm typecheck
pnpm build

# 6. End-to-end (Playwright starts its own server)
pnpm playwright test

# 7. Design checks
node <taste-skill>/scripts/lint.mjs --app src
node <taste-skill>/scripts/inspect.mjs --app http://localhost:3010/login
```

---

## 7. To finish verification, a human must do this

In order, per platform:

1. Complete the access requirements in `docs/PLATFORM-ACCESS.md`.
2. Put the credentials in `.env` and set the platform's `*_ENABLED` flag to `true`.
3. Connect one real account for one client.
4. Publish a text post; confirm the id in `PostTarget.platformPostId` resolves to a real, visible post.
5. Publish a post with an image; confirm the same.
6. Deliberately submit an invalid post; confirm it is rejected **before** enqueueing.
7. Revoke the token at the platform; confirm the account shows "Needs reconnecting" and the post fails
   with a clear message rather than crashing.
8. Record the platform post URL in `docs/TEST-REPORT.md`.

Steps 4-7 are the definition of "this integration works". Until they are done for a platform, its flag
stays off.
