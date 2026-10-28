# CW Social Publisher

Internal console for ColorWhistle's team to write a post once and publish it to multiple clients'
Facebook, Instagram, LinkedIn and X accounts, immediately or on a schedule.

**Internal use only.** Clients do not sign in.

---

## What it does

- **Clients** — separate records per client, with accounts and posts scoped to them.
- **Social accounts** — connected through each platform's official OAuth flow. Tokens are encrypted at
  rest and never reach the browser.
- **Composer** — one caption, many targets, with a per-platform override and live character counts.
- **Publishing** — immediately or scheduled, through a persistent queue that survives restarts.
- **Per-account results** — if three platforms succeed and one fails, all four outcomes are kept.
- **Calendar and history** — including the exact reason a post failed and a safe retry.
- **Audit log** — every sign-in, connection, publish, retry and cancellation.

---

## Quick start

```bash
# 1. Install
pnpm install

# 2. Infrastructure (Postgres, Redis, S3-compatible storage)
docker compose up -d

# 3. Environment
cp .env.example .env
# Fill SESSION_SECRET and TOKEN_ENCRYPTION_KEY:
#   openssl rand -base64 32

# 4. Schema and seed
pnpm db:migrate
pnpm db:seed

# 5. Run the web app
pnpm dev            # http://localhost:3010

# 6. Run the publishing worker (separate terminal)
pnpm dev:worker
```

Sign in with the seeded admin:

| Email | Password |
| --- | --- |
| `admin@colorwhistle.com` | `ChangeMe!2026` |

**Change that password before anything else.**

---

## Ports

Deliberately non-default, because 3000/5432/56379 are commonly already in use:

| Service | Port |
| --- | --- |
| Web app | 3010 |
| Postgres | 55440 |
| Redis | 56390 |
| S3 (RustFS) | 9010, console 9011 |

---

## Platform availability

All four adapters are built. **None is enabled by default**, because enabling a platform without its
credentials and approvals produces an integration that fails at publish time rather than at setup time.

| Platform | Adapter | Needs |
| --- | --- | --- |
| Facebook Pages | ✅ built | Meta app + App Review for `pages_manage_posts` |
| Instagram | ✅ built | Meta app + App Review + a professional account linked to a Page |
| LinkedIn | ✅ built | LinkedIn app; **organisation posting needs manual Community Management API approval** |
| X | ✅ built | X developer account with credits; `offline.access` for scheduling |

The **Social accounts** screen names any platform that is not configured, so the state is visible
rather than mysterious. Steps for each are in [`docs/PLATFORM-ACCESS.md`](docs/PLATFORM-ACCESS.md).

> No platform integration in this repository has been verified against a live account. See
> [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) §5.

---

## Architecture in one paragraph

One Next.js app (UI plus API) and one worker process, sharing a Postgres database and a Redis queue.
An adapter interface isolates each social network, so the composer and the worker never branch on
platform name. `PostTarget` — one post to one account — is the unit of publishing work, which is what
makes partial success representable. Publishing is protected against duplicates by four independent
layers: a deterministic job id, a transactional claim, a unique attempt number, and a rule that refuses
to auto-retry an ambiguous outcome. Full detail in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Documentation

| Document | Contents |
| --- | --- |
| [`PLAN.md`](PLAN.md) | Requirements, tasks, dependencies, risks, acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design and the reasoning behind each decision |
| [`docs/DATABASE.md`](docs/DATABASE.md) | Schema, indexes, and the constraints that prevent real bugs |
| [`docs/API.md`](docs/API.md) | Endpoint contracts, error codes, conventions |
| [`docs/PLATFORM-ACCESS.md`](docs/PLATFORM-ACCESS.md) | Per-platform approval checklist and blockers |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | VPS deployment, backups, monitoring |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Runbook for the team who operates it |
| [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) | What was verified, and what was not |

---

## Scripts

```bash
pnpm dev              # web app on :3010
pnpm dev:worker       # publishing worker, watch mode
pnpm build            # production build
pnpm start            # serve the production build
pnpm worker           # publishing worker, production

pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm test             # unit + integration (vitest)
pnpm e2e              # end-to-end (playwright)

pnpm db:migrate       # create and apply a migration
pnpm db:deploy        # apply migrations (production)
pnpm db:reset         # drop, recreate, migrate, seed
pnpm db:seed          # seed admin and the two clients
pnpm db:studio        # browse the database
```

---

## Security posture

- Sessions are database-backed, so deactivation and role changes take effect immediately.
- Cookie is `__Host-` prefixed in production (Secure, no Domain, Path=/).
- Mutations are origin-checked, which closes CSRF without a token ceremony.
- OAuth state is single-use, session-bound and expires in 10 minutes; X uses PKCE.
- Tokens live in one table, encrypted with AES-256-GCM, decrypted in exactly one function.
- Logs redact credentials before serialisation, at any depth.
- Cross-client access returns `404`, never `403`, so the API does not confirm that other data exists.
- Login is rate limited per IP **and** per account, with one generic failure message.

---

## License

Proprietary. Internal ColorWhistle project.
