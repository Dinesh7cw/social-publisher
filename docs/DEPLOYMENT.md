# Deployment

Target: a single VPS running Docker, with Postgres, Redis, the web app, the worker and an nginx
reverse proxy. This matches the brief's deployment requirement.

> **Honesty note.** The configuration below is written and reviewed but **was not executed against a
> live VPS**, because this environment has no server to deploy to. The Docker images build locally
> and the compose file is validated, but "deployed and verified on a VPS" is not a claim this project
> can make. Section 9 lists exactly what remains unverified.

---

## 1. Prerequisites on the server

| Item | Requirement |
| --- | --- |
| OS | Ubuntu 22.04/24.04 LTS or equivalent |
| Docker | 27+ with the Compose plugin |
| RAM | 2 GB minimum (4 GB comfortable with Next.js + Postgres) |
| Disk | 20 GB minimum, more if media is stored locally |
| DNS | An A record for your app host pointing at the server |
| Ports | 80 and 443 open; 3010, 5432 and 6379 **not** exposed to the internet |

---

## 2. First deployment

```bash
# 1. Get the code onto the server
git clone <your-repo> /opt/cw-social
cd /opt/cw-social

# 2. Create the production environment file
cp .env.production.example .env.production
chmod 600 .env.production
# Edit every CHANGE_ME value:
#   - POSTGRES_PASSWORD         a long random string
#   - SESSION_SECRET            openssl rand -base64 32
#   - TOKEN_ENCRYPTION_KEY      openssl rand -base64 32
#   - APP_ORIGIN / APP_URL      your real https origin
#   - S3_* / MEDIA_PUBLIC_BASE_URL

# 3. TLS certificates
mkdir -p certs
# Either copy existing certificates, or issue them:
#   certbot certonly --standalone -d publisher.colorwhistle.com
#   cp /etc/letsencrypt/live/<domain>/fullchain.pem certs/
#   cp /etc/letsencrypt/live/<domain>/privkey.pem  certs/

# 4. Build and start
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# 5. Create the first admin (one time, before anyone can sign in)
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  -e SEED_ADMIN_EMAIL=you@colorwhistle.com \
  -e SEED_ADMIN_PASSWORD='a-strong-temporary-password' \
  app pnpm db:seed

# 6. Verify
curl -fsS https://publisher.colorwhistle.com/api/health
```

Expected health response:

```json
{ "status": "ok", "database": "ok", "redis": "ok", "platforms": { "FACEBOOK": "disabled", ... } }
```

Sign in at `https://<your-host>/login` and change the seeded password immediately through the team
settings screen.

---

## 3. What runs

| Container | Role | Restart |
| --- | --- | --- |
| `proxy` | nginx: TLS, rate limiting at the edge, security headers | unless-stopped |
| `app` | Next.js web + API | unless-stopped |
| `worker` | BullMQ consumer for publishing | unless-stopped |
| `migrate` | one-shot `prisma migrate deploy` | runs once per `up` |
| `postgres` | system of record | unless-stopped |
| `redis` | job queue, AOF persistence | unless-stopped |

The `app` and `worker` share one image. The worker is a separate process because a publishing stall
must not take the UI down, and because BullMQ consumers must not be scaled horizontally inside a
request-serving process.

---

## 4. Updating

```bash
cd /opt/cw-social
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

The `migrate` service runs before `app` and `worker` start, so a schema change is applied before new
code serves traffic. The worker finishes in-flight jobs before exiting, so a deploy does not abandon a
half-published post.

**Before any migration that drops or narrows a column**, take a backup (§6). No destructive migration
should ever ship without one.

---

## 5. Environment variables

Every variable is documented in `.env.production.example`. The ones that most often go wrong:

| Variable | Consequence if wrong |
| --- | --- |
| `APP_ORIGIN` | Must exactly match the browser's origin. A mismatch makes every mutation fail the CSRF origin check with `FORBIDDEN`. |
| `TOKEN_ENCRYPTION_KEY` | Changing it without re-encrypting makes every stored OAuth token undecryptable. Accounts then need reconnecting. |
| `SESSION_SECRET` | Changing it signs every user out. |
| `MEDIA_PUBLIC_BASE_URL` | Must be publicly reachable over HTTPS. If it is not, Facebook and Instagram publishing fails because Meta cannot fetch the media. |
| `S3_BUCKET` public bucket | Must allow anonymous GET for the media projection. |
| `*_ENABLED` flags | A platform with its flag off cannot publish, and the UI says so rather than failing at publish time. |

The app validates the environment at startup (`src/instrumentation.ts`) and refuses to run with a
placeholder key, a malformed URL, or a production build pointed at a test database.

---

## 6. Backups

Postgres holds everything that matters; Redis holds only the queue, which the reconciler rebuilds.

```bash
# Nightly database dump (add to crontab: 0 2 * * *)
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U cw -Fc cw_social > /opt/backups/cw-$(date +%F).dump

# Prune older than 14 days
find /opt/backups -name 'cw-*.dump' -mtime +14 -delete
```

Restore:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U cw -d cw_social --clean --if-exists < /opt/backups/cw-2026-11-01.dump
```

Test the restore on a scratch database at least once. An untested backup is not a backup.

---

## 7. Monitoring

- `/api/health` returns `503` when either Postgres or Redis is unreachable. Point an uptime monitor at
  it.
- Logs are JSON to stdout, capped at 10 MB × 5 files per container.
- Log lines carry `requestId`, `postId`, `targetId`, `attemptNo` and `platform`, and every
  `PublishingAttempt` row stores the same `requestId`, so a log line and a database row can be joined
  when diagnosing a failure.
- Tokens are redacted at the logger before serialisation, not left to reviewer discipline.

```bash
docker compose -f docker-compose.prod.yml logs -f worker
docker compose -f docker-compose.prod.yml logs -f app | grep '"level":50'
```

---

## 8. Scaling

For an agency's volume this stack is comfortably adequate. If it ever is not:

1. **Worker** — raise `WORKER_CONCURRENCY`; publishing is I/O bound. The transactional claim in the
   executor makes multiple workers safe.
2. **App** — run more `app` replicas behind the proxy. Sessions are database-backed, so no sticky
   routing is needed.
3. **Postgres** — the first real bottleneck. Add connection pooling before adding hardware.

---

## 9. What is not verified

Stated plainly so nobody assumes otherwise:

| Item | Status |
| --- | --- |
| Docker image builds | ✅ verified locally |
| `docker compose config` validates | ✅ verified |
| App runs and serves every screen | ✅ verified locally against real Postgres, Redis and S3 |
| Deployed to a real VPS and reachable over the internet | ❌ **not done** — no server available |
| TLS certificates issued by a real CA | ❌ not done |
| Backup and restore executed | ❌ documented, not run |
| Publishing to any real social account | ❌ **not done** — no credentials exist |
| Load or soak testing | ❌ not done |

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Health returns 503 | Postgres or Redis down | `docker compose ps`, then check that container's logs |
| Every mutation returns `FORBIDDEN` | `APP_ORIGIN` does not match the browser origin | Correct `APP_ORIGIN`, recreate the `app` container |
| Users signed out unexpectedly | `SESSION_SECRET` changed | Expected; they sign in again |
| Every account shows "needs reconnecting" | `TOKEN_ENCRYPTION_KEY` changed or lost | Restore the old key, or reconnect each account |
| Instagram publishing fails with a media error | Media URL not publicly reachable | Check `MEDIA_PUBLIC_BASE_URL` resolves and the public bucket allows anonymous GET |
| Scheduled posts stop firing | Worker down, or Redis flushed | `docker compose logs worker`; the reconciler re-enqueues stranded targets within 5 minutes |
| `PLATFORM_DISABLED` on publish | The platform's flag is off or its credentials are missing | Follow `docs/PLATFORM-ACCESS.md`, then enable the flag |
