# CW Social Publisher — Implementation Plan

> Internal social media management console for ColorWhistle (CW).
> One post → many client accounts → Facebook, Instagram, LinkedIn, X.
>
> **Status: Phases 1-5 and 7 complete. Phase 6 (live platform verification) is blocked on credentials
> that do not exist in this environment — see `docs/TEST-REPORT.md` §5 for the honest account of what
> is and is not verified.**

---

## 1. Repository assessment (Phase 1)

**Environment inspected on 2026-10-28.**

| Item | Finding |
| --- | --- |
| Workspace | `D:\post` — **empty**, no pre-existing code, no `package.json`, no `.git` |
| Existing work at risk | None. Nothing to overwrite. |
| OS / shell | Windows 10.0.26200, PowerShell |
| Node | v24.13.0 |
| npm / pnpm | 11.6.2 / 10.30.3 (pnpm is the chosen package manager) |
| Docker | 29.7.2 with Compose v5.3.1, daemon running |
| `psql` / `redis-cli` | Not on PATH — use Docker containers instead of host installs |
| Ports already in use | 3000, 5432, 55432, 56379, 8080-8095, 3306, 443, 80 |
| Ports chosen for this project | **3010** (app), **55440** (Postgres), **56390** (Redis), **9010** (MinIO S3), **9011** (MinIO console) |

**Consequences**

- Greenfield build: no migration of legacy data, no framework constraints inherited.
- Because 3000/5432/55432/56379 are occupied by other local projects, this project must map to its
  own ports and must never assume defaults. All connection strings come from `.env`.
- Integration tests may spin up isolated Docker containers; they are not allowed to touch the
  developer's other running databases.

---

## 2. Verified platform facts (checked 2026-10-28, not assumed)

These were read from live vendor documentation during Phase 1. They drive the adapter design and
the access checklist. Anything not verified here is marked as needing confirmation.

### Meta / Facebook Pages

- Publish via `POST /{page-id}/feed` with `message`, optional `link`, on Graph API **v26.0**.
- Photos: `POST /{page-id}/photos` with a **publicly reachable `url`** (Meta fetches it).
  Returns `{ id, post_id }`.
- Videos: separate Video API path; `publish_video` permission required.
- Permissions: `pages_manage_posts`, `pages_read_engagement`, and `pages_manage_engagement` per the
  posts guide. User must be able to perform `CREATE_CONTENT`, `MANAGE`, `MODERATE` on the Page.
- Native scheduling exists (`published=false` + `scheduled_publish_time`, 10 min – 30 days) but we
  **do not use it**: our own queue must own scheduling so all four platforms behave identically.

### Instagram (professional accounts)

- Two configurations exist. We target **Instagram API with Facebook Login**
  (`graph.facebook.com`, Page access token, permissions `instagram_basic` +
  `instagram_content_publish` + `pages_read_engagement`) because the same Meta app and the same
  OAuth round-trip already needed for Facebook Pages covers it.
- Publishing is two-step: `POST /{ig-id}/media` (container) → `POST /{ig-id}/media_publish`
  with `creation_id`. Container status via `GET /{container-id}?fields=status_code`
  (`IN_PROGRESS` / `FINISHED` / `PUBLISHED` / `ERROR` / `EXPIRED`).
- **Media must be on a public server** — Meta cURLs the URL. This forces a real decision on media
  storage (see Risk R3).
- **JPEG only** for images. Carousels up to 20 items. Rate limit: 100 API-published posts / 24 h,
  enforced at `media_publish`; `GET /{ig-id}/content_publishing_limit` reports usage.
- Page Publishing Authorization (PPA) can block publishing and cannot be detected by the app.

### LinkedIn

- Posts API replaces `ugcPosts`: `POST https://api.linkedin.com/rest/posts`.
- Requires headers `Linkedin-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`.
- Success is **HTTP 201** and the post ID arrives in the **`x-restli-id` response header**, not the
  body. Body-level `"id"` must not be assumed.
- `author` is a URN: `urn:li:person:{id}` for a member, `urn:li:organization:{id}` for a page.
- Permissions: `w_member_social` (member) and `w_organization_social` (organization, requires the
  authenticated member to hold a page role such as `ADMINISTRATOR`).
- Images require the Images API to obtain an `urn:li:image:{id}` before the post is created.
- **Access is gated**: the *Community Management API* product must be requested and manually
  approved (typically weeks), and `r_member_social` is restricted. This is a hard external blocker
  for organization posting — see Risk R1 and `docs/PLATFORM-ACCESS.md`.

### X (Twitter)

- Publish via `POST https://api.x.com/2/tweets` (JSON body `{ "text": "..." }`).
- Auth: OAuth 2.0 Authorization Code **with PKCE**, scopes `tweet.read tweet.write users.read
  media.write offline.access`.
- Access tokens last ~2 h; **`offline.access` is mandatory** to get a refresh token. A scheduler
  that stores a token at connect time and publishes hours later will fail without refresh.
- Media upload uses a separate v2 media endpoint; `media.write` scope required.
- Pricing is **pay-per-use credits** (no Free/Basic/Pro tiers as of 2026): post create ≈ $0.015,
  but **≈ $0.20 when the post contains a URL**. This is a real cost signal for the composer UI.
- Character limit 280 on the standard endpoint; URL length is counted as a fixed cost, not raw length.
- x.com docs returned HTTP 403 to automated fetches; the above was confirmed via search results and
  must be re-checked against the in-app developer portal before go-live.

**Honesty note:** no real credentials exist in this environment. Every adapter is therefore built to
be *verifiably correct* (typed, unit-tested against recorded fixtures, guarded by feature flags) but
**no adapter is claimed to be production-verified** until a human completes the OAuth round-trip with
real accounts, as required by the brief ("Do not claim that a platform integration works until it has
been verified").

---

## 3. Architecture summary

See `docs/ARCHITECTURE.md` for the full document. Short form:

```
Browser ──HTTPS──> Next.js (App Router, RSC + route handlers)
                     │
                     ├── Postgres (Prisma)  ← system of record
                     ├── Redis (BullMQ)     ← schedule + retry
                     └── S3/MinIO           ← media originals + public CDN copy
                             │
                     Worker process (separate container)
                             └── Adapter registry → Meta | Instagram | LinkedIn | X
```

Decisions and their reasons:

| Decision | Reason |
| --- | --- |
| One Next.js app + one worker process, not microservices | Internal tool, small team, one deployable unit. The worker is separated only because BullMQ consumers must not live inside a request-serving process that scales horizontally. |
| Own scheduler, not platform-native scheduling | Four platforms, four different native-schedule semantics (Meta 10 min–30 days, LinkedIn none, X none). One queue = one mental model, one retry policy, one audit trail. |
| PostTarget is the unit of work | Partial success is a first-class requirement. One job per **target**, not one job per post. |
| `Post.status` is derived from targets | A post is `PUBLISHED` only when every target is `PUBLISHED`; `PARTIAL` when mixed. Nothing is marked published before the platform returns a success signal. |
| Tokens in a separate table, AES-256-GCM at rest | Keeps secrets out of every ordinary `select *`, out of Prisma's relation graphs, and out of React payloads. Envelope encryption with a key from env/KMS. |
| Adapters are pure modules behind one interface | Each platform's quirks stay in its own folder; the composer and worker never branch on platform name. |
| Public media URLs via a signed, unguessable path | Instagram and Meta require Meta's servers to fetch the file. A private bucket cannot be fetched, so a read-only public projection is required (Risk R3). |

---

## 4. Workstreams

Multi-agent workflow as requested. Each workstream owns a disjoint file set; shared contracts are
frozen before parallel work starts.

| # | Agent | Owns | Depends on |
| --- | --- | --- | --- |
| 0 | **Lead / Orchestrator** | `PLAN.md`, `docs/**`, `prisma/schema.prisma`, `src/lib/**` contracts, integration + review | — |
| 1 | Architecture | `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/API.md` | 0 |
| 2 | Backend | `src/app/api/**`, `src/server/**` (auth, CRUD, validation) | 0 schema |
| 3 | Frontend | `src/app/(app)/**`, `src/components/**`, `src/styles/**` | 0 tokens, 2 API |
| 4 | Meta integration | `src/server/platforms/meta/**`, `instagram/**` | 0 adapter interface |
| 5 | LinkedIn integration | `src/server/platforms/linkedin/**` | 0 adapter interface |
| 6 | X integration | `src/server/platforms/x/**` | 0 adapter interface |
| 7 | Infrastructure | `Dockerfile`, `docker-compose*.yml`, `deploy/**`, logging, health | 0 |
| 8 | QA / Security | `tests/**`, `e2e/**`, security checklist | 2, 4-6 |

**Conflict avoidance:** the frozen contracts are `src/server/platforms/types.ts`,
`src/lib/domain.ts` (enums/statuses), and `prisma/schema.prisma`. No agent edits another's folder.
Workstreams 4-6 share zero files with each other.

**Serialisation point:** the lead merges schema + adapter interface first, then releases 2 and 4-6 in
parallel, then 3 against a mocked API layer, then 8.

---

## 5. Task breakdown

### Phase 2 — Foundation, auth, clients, dashboard

| ID | Task | Dep | Acceptance criteria |
| --- | --- | --- | --- |
| 2.1 | pnpm project, Next 16 + TS 5.9 + Tailwind 4, strict tsconfig | — | `pnpm build` compiles with `strict: true`; no `any` in domain code |
| 2.2 | Docker Compose: Postgres 16, Redis 7, MinIO | — | `docker compose up -d` → all three healthy on project ports |
| 2.3 | Prisma schema + first migration | 2.2 | `prisma migrate dev` creates all 9 entities, FKs, indexes, enums; `prisma migrate reset` is idempotent |
| 2.4 | Token cipher (AES-256-GCM, versioned envelope) | 2.1 | Round-trip test; tampered ciphertext throws; wrong key throws; plaintext never appears in serialised output |
| 2.5 | Session auth: argon2id, DB-backed sessions, httpOnly `__Host-` cookie | 2.3 | Login/logout/expiry tests; session revoked on password change; cookie flags asserted |
| 2.6 | RBAC (`ADMIN`, `MEMBER`) + server-side authorisation guard | 2.5 | Every private API route calls `requireUser`/`requireAdmin`; negative tests per route |
| 2.7 | Client CRUD + archive + search, scoped | 2.6 | Cross-client access returns 404 (not 403, to avoid existence leak); archived clients excluded from pickers |
| 2.8 | Dashboard aggregates + recent activity | 2.7 | Counts computed by SQL aggregation, not client-side; all six counters present |
| 2.9 | Login UI + app shell (taste-skill `accent-ladder`) | 2.5 | Inspector 0 FAIL at 1440/768/390 |

### Phase 3 — Composer, media, drafts, calendar

| ID | Task | Dep | Acceptance criteria |
| --- | --- | --- | --- |
| 3.1 | S3 storage service + presigned direct upload | 2.2 | Upload → store → signed read URL; MIME sniffed by magic bytes, not extension |
| 3.2 | Public media projection for Meta/IG | 3.1 | Unguessable path, `Content-Type` fixed, no listing; documented in ARCHITECTURE |
| 3.3 | Platform capability table (limits, media rules) | 0 | One source of truth; unit-tested against the numbers in §2 |
| 3.4 | `validateForPlatform()` per adapter | 3.3 | Rejects: >280 chars on X, PNG on IG, >20 carousel items, 0 media on IG, etc. |
| 3.5 | Composer: base caption, per-target override, target picker | 3.4 | Multi-client, multi-account selection; per-platform edit; live counter |
| 3.6 | Drafts + duplicate | 3.5 | Duplicate creates a new DRAFT with copied targets and media, no publish state |
| 3.7 | Calendar month + week views, filters | 3.6 | Timezone-correct bucketing; filters by client/platform/status; cancel + reschedule |
| 3.8 | Composer + calendar UI | 3.5 | Empty/loading/error states; keyboard reachable |

### Phase 4 — Queue, publishing, history

| ID | Task | Dep | Acceptance criteria |
| --- | --- | --- | --- |
| 4.1 | BullMQ queue + worker bootstrap, graceful shutdown | 2.2 | Worker survives restart with jobs intact (test asserts job resumption) |
| 4.2 | Idempotency: stable `jobId` per target + `idempotencyKey` unique on attempt | 4.1 | Same target cannot be enqueued twice; duplicate execution is a no-op |
| 4.3 | Publish executor: per-target state machine | 4.2 | `PENDING → RUNNING → PUBLISHED|FAILED|SKIPPED`; post status derived |
| 4.4 | Retry policy: exponential backoff, transient vs permanent classification | 4.3 | Transient → retried up to N with jitter; permanent (auth/validation) → no retry, actionable message |
| 4.5 | Rate-limit handling per platform | 4.4 | 429 → delayed retry using `Retry-After`/reset header; never a hot loop |
| 4.6 | Token refresh before publish | 4.3 | Expired token → refresh → retry once → `NEEDS_RECONNECT` if refresh fails |
| 4.7 | Publishing history + attempt detail + manual retry | 4.3 | Every attempt persisted with request id, platform id, url, error class |
| 4.8 | Audit log on every publish/connect/disconnect/retry | 4.7 | Actor, action, target, before/after, timestamp; no secrets |

### Phase 5 — Platform adapters

| ID | Task | Dep | Acceptance criteria |
| --- | --- | --- | --- |
| 5.1 | Meta OAuth (Facebook Login) + page list + long-lived token exchange | 2.4 | State validated; PKCE where applicable; token encrypted on write |
| 5.2 | Facebook Page adapter (text, link, photo) | 5.1 | Fixture tests for success + each documented error code |
| 5.3 | Instagram adapter (container → publish → status poll) | 5.2 | JPEG-only enforced; carousel path; `content_publishing_limit` checked pre-publish |
| 5.4 | LinkedIn OAuth + member/org discovery | 5.1 | Org URNs only listed when the member holds an admin role |
| 5.5 | LinkedIn Posts adapter | 5.4 | Reads ID from `x-restli-id` header; `Linkedin-Version` header sent |
| 5.6 | X OAuth 2.0 PKCE + refresh | 2.4 | Refresh token stored; refresh rotates correctly |
| 5.7 | X adapter (text, URL cost warning, media) | 5.6 | 280-char validation; media upload then tweet |
| 5.8 | Feature flags per platform | 5.2-5.7 | Disabled platform is hidden in UI and rejected server-side with a clear message |

### Phase 6 — Real-account verification

| ID | Task | Dep | Acceptance criteria |
| --- | --- | --- | --- |
| 6.1 | Meta test app + page + IG professional account | external | Documented in `docs/PLATFORM-ACCESS.md`, screenshots of results |
| 6.2 | LinkedIn Community Management API approval | external | **Blocked until approved** — flag stays off |
| 6.3 | X developer account + credits | external | Publish one text post, one with URL; cost recorded |
| 6.4 | Record real outcomes | 6.1-6.3 | `docs/TEST-REPORT.md` lists what was actually published, with platform post IDs |

**This phase cannot be completed in this environment.** No credentials, no business verification, no
approved LinkedIn app. See `docs/PLATFORM-ACCESS.md` and the Known Limitations in
`docs/DEPLOYMENT.md`. The plan does not pretend otherwise.

**What was done instead:** every adapter is implemented and unit-tested against mocked responses that
model the documented shapes, including the quirks that break naive implementations (LinkedIn's
header-only post id, Instagram's two-step publish, X's URL character counting). Each platform is behind
a feature flag that defaults to off, and the UI states plainly which platforms are not configured.

**To complete Phase 6, a human with credentials must follow `docs/TEST-REPORT.md` §7.**

### Phase 7 — Hardening, deploy, docs

| ID | Task | Dep | Acceptance criteria |
| --- | --- | --- | --- |
| 7.1 | Rate limiting on auth + mutating APIs | 4 | Sliding window in Redis; 429 with `Retry-After` |
| 7.2 | Input validation on every route (zod) | 2 | No route reads `req.json()` without a schema |
| 7.3 | Security headers, CSP, CSRF protection for cookie auth | 2 | Origin check on mutations; CSP without `unsafe-eval` |
| 7.4 | Structured logging + redaction of tokens/secrets | 7 | Log serialiser drops known secret keys; asserted by test |
| 7.5 | Health/readiness endpoints | 7 | `/api/health` checks DB + Redis |
| 7.6 | Dockerfile (multi-stage) + compose for prod | 7 | Image < 300 MB, non-root user, `NODE_ENV=production` |
| 7.7 | Nginx reverse proxy + TLS + restart policy | 7.6 | Documented, not executed (no VPS access) |
| 7.8 | Docs: deployment, OAuth per platform, ops runbook, limitations | all | Every env var in `.env.example` is documented with its source |

---

## 6. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| **R1** | LinkedIn Community Management API is not self-serve; approval takes weeks and may be refused | High | High | Ship LinkedIn behind `LINKEDIN_ENABLED=false`. Personal-profile posting (`w_member_social`) is the documented fallback. Never fabricate org publishing. |
| **R2** | Meta App Review required for `pages_manage_posts` / `instagram_content_publish` in Live mode | High | High | Document exact permission list + screencast requirements. App works in Development mode with added testers meanwhile. |
| **R3** | Instagram/Meta require **public** media URLs; a private bucket can't be fetched | Certain | Medium | Dual storage: private original + public read-only projection with unguessable keys; documented retention/cleanup. |
| **R4** | X is pay-per-use; URL posts cost ~13× a text post | Medium | Medium | Composer shows a cost note when a URL is present; usage logged per publish for reconciliation. |
| **R5** | Instagram 100 posts/24h and Meta rate limits under agency batch posting | Medium | Medium | Pre-flight `content_publishing_limit` check; backoff on 429; per-account throttling in the worker. |
| **R6** | Timezone/DST correctness for scheduling | Medium | High | Store all instants as UTC; client sends IANA zone; calendar buckets in the client's zone; DST tests included. |
| **R7** | Duplicate publication (double-click, worker retry after ambiguous failure) | Medium | High | Unique `(postTargetId, attemptNo)`; `idempotencyKey`; pre-publish `PUBLISHING` claim in a transaction; on ambiguous failure, mark `UNKNOWN` and require human confirmation instead of blind retry. |
| **R8** | Token leakage via logs, error messages, or API responses | Medium | Critical | Tokens in separate table, never selected by default; log redaction; adapters receive a token via a scoped accessor, never a full account object. |
| **R9** | Prisma 7 changed generator/output requirements | Low | Low | Verified: use `provider = "prisma-client"` with explicit `output`. Pinned. |
| **R10** | Windows dev + Docker volume/perf quirks | Medium | Low | Containers hold data; code is bind-mounted only for dev; worker runs natively via `pnpm` for fast iteration. |

---

## 7. Definition of Done mapping

| Brief requirement | Where it is satisfied |
| --- | --- |
| Secure team login | 2.5, 2.6 |
| Admin creates/manages clients | 2.7 |
| Accounts connectable via OAuth | 5.1, 5.4, 5.6 |
| One post → many accounts | 3.5 |
| Immediate + scheduled publishing per platform | 4.1-4.6, 5.2, 5.3, 5.5, 5.7 |
| Per-target status | 4.3, 4.7 |
| Failed posts diagnosable and retryable | 4.4, 4.7 |
| Jobs survive restart | 4.1 |
| Automated tests pass | 8, Phase 7 |
| Docs complete | 7.8 |

---

## 8. What this plan deliberately does not do

- No analytics/insights ingestion (explicitly deferred by the brief).
- No client-facing logins.
- No browser automation of any platform. Ever.
- No claim of verified platform publishing without a real credential round-trip.
