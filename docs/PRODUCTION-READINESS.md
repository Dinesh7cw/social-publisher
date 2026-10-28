# Production readiness checklist

Tick every item before declaring the system live. Items marked **BLOCKED** cannot be completed in this
environment and require a human with credentials or server access.

---

## 1. Code and build

- [x] `pnpm typecheck` passes with `strict` and `noUncheckedIndexedAccess`
- [x] `pnpm build` succeeds; all 38 routes compile
- [x] `pnpm lint` passes
- [x] Unit tests pass (71)
- [x] Integration tests pass against real Postgres and Redis (45)
- [x] End-to-end tests pass at 1440, 768 and 390 (53)
- [x] Design inspector: 0 FAIL on the login screen
- [x] No `any` in domain or server code
- [x] No `console.log` of tokens, secrets or full request bodies

---

## 2. Security

- [x] All private routes require a session (verified by test)
- [x] All mutations check the request origin (CSRF)
- [x] Role guards are server-side, not UI-only
- [x] Cross-client access returns 404, not 403
- [x] Passwords hashed with argon2id (19 MiB, t=2, p=1)
- [x] Sessions are database-backed and revoked on role change or deactivation
- [x] Session cookie is httpOnly, SameSite=Lax, Secure and `__Host-` prefixed in production
- [x] OAuth state is random, session-bound, single-use, 10-minute expiry
- [x] X uses PKCE
- [x] Tokens encrypted with AES-256-GCM, versioned envelope for rotation
- [x] Tokens decrypted in exactly one function, never in the web process for display
- [x] No token appears in any API response (asserted by test)
- [x] No token appears in logs (redaction at the serialiser, asserted by test)
- [x] Audit metadata redacted at write time
- [x] Login rate limited per IP and per account, with one generic failure message
- [x] Upload type decided by magic bytes, not the client's claim
- [x] EXIF stripped by re-encoding
- [x] Redirects not followed on platform API calls (no token leak to another host)
- [x] Security headers set in both nginx and Next config
- [x] `.env` gitignored; `.env.example` has placeholders only

- [ ] **BLOCKED** — Penetration test
- [ ] **BLOCKED** — Dependency audit against a live advisory database
- [ ] **BLOCKED** — Verify TLS configuration with a real certificate (e.g. SSL Labs)

---

## 3. Publishing correctness

- [x] A post is marked published only after the platform returns an id (tested)
- [x] Partial success keeps every outcome (tested with four targets)
- [x] Duplicate job delivery does not double-publish (tested by asserting the fetch call count)
- [x] Ambiguous outcomes are never auto-retried (tested)
- [x] Permanent failures are not retried (tested)
- [x] Rate limits honour `Retry-After` (tested)
- [x] Token refresh happens before publish when expired
- [x] Scheduled jobs survive a restart (tested by tearing down connections and reconnecting)
- [x] A reconciler re-enqueues stranded targets
- [x] Validation blocks the entire batch, not just the failing target

- [ ] **BLOCKED** — Publish to a real Facebook Page and confirm the live post
- [ ] **BLOCKED** — Publish to a real Instagram account, including an image
- [ ] **BLOCKED** — Publish to a real LinkedIn profile
- [ ] **BLOCKED** — Publish to a real LinkedIn organisation (needs Community Management API approval)
- [ ] **BLOCKED** — Publish to a real X account, one text post and one with a URL
- [ ] **BLOCKED** — Revoke a real token and confirm the reconnect path
- [ ] **BLOCKED** — Confirm a DST transition with a real scheduled post

---

## 4. Data

- [x] Migrations are versioned and applied by a dedicated container before app start
- [x] Foreign keys prevent orphaned rows
- [x] Unique constraints prevent the three dangerous duplicates
- [x] `onDelete: Restrict` where history must survive
- [x] Test database guard prevents truncating a non-test database

- [ ] A backup has been taken and **restored successfully** (documented, not run)
- [ ] Retention policy agreed with CW for media and audit logs
- [ ] Indexes reviewed against real query patterns at volume

---

## 5. Operations

- [x] Health endpoint reports database and Redis state
- [x] Structured logs with request correlation
- [x] Worker shuts down gracefully, finishing in-flight jobs
- [x] Restart policies set on every service
- [x] Log rotation configured (10 MB × 5)
- [x] Docker image runs as a non-root user
- [x] Deployment guide complete
- [x] Operations runbook complete
- [x] Troubleshooting table for the failures that actually happen

- [ ] **BLOCKED** — Deployed to a VPS and reachable over HTTPS
- [ ] **BLOCKED** — Uptime monitoring configured and alerting
- [ ] **BLOCKED** — Log aggregation configured
- [ ] **BLOCKED** — Postgres connection pooling sized for real traffic

---

## 6. Platform access

For each platform, all of these must be true before enabling it:

- [ ] Credentials in the secrets store (not in git)
- [ ] Redirect URI registered with the exact production URL
- [ ] Required permissions approved (App Review for Meta; Community Management API for LinkedIn org)
- [ ] Instagram: professional account confirmed, Page-linked, PPA completed
- [ ] X: credits funded, `offline.access` confirmed
- [ ] Test publish completed and the platform post id verified as a real, visible post
- [ ] `*_ENABLED=true` set only after the above
- [ ] Result recorded in `docs/TEST-REPORT.md`

Current state: **none of the four platforms is enabled.** See `docs/PLATFORM-ACCESS.md`.

---

## 7. Team readiness

- [ ] At least one admin account created with a strong password (the seeded one replaced)
- [ ] Every team member has their own account (no shared logins)
- [ ] The team has read `docs/OPERATIONS.md`
- [ ] The team knows what **Needs checking** means and why they must look before retrying
- [ ] Someone owns the weekly check: failed posts, accounts needing reconnection, X credit balance

---

## 8. Sign-off

This system is ready for internal use when:

1. Sections 1, 2, 3 and 5 have no unticked non-blocked items.
2. At least one platform has completed section 6 and is genuinely publishing.
3. A backup has been restored successfully once.
4. The team has been walked through the "Needs checking" case.

It is **not** ready if any platform is enabled without its verification complete, or if the seeded admin
password is still in place.
