# Student Assignment Tracker (ECE1779)

React + Express + PostgreSQL in Docker, deployed with Docker Swarm on DigitalOcean.

## Run locally

```bash
cp .env.example .env     # edit the passwords and JWT_SECRET
docker compose up --build
```

Frontend: http://localhost:3000 · Backend health: http://localhost:4000/api/health

The backend creates its tables on startup, so there is no separate schema step.
To wipe the database: `docker compose down -v`.

## Files

| File | What it holds |
|---|---|
| `backend/server.js` | SKELETON: schema, DB startup and health are done; auth, courses, assignments, sub-assignments, progress are `TO-DO` (routes return 501) |
| `backend/notifier.js` | SKELETON: scheduling done; `sendEmail()` and `run()` are `TO-DO` |
| `frontend/src/App.jsx` | Login, dashboard, assignments + sub-tasks, courses, calendar |
| `frontend/index.html` | Page shell and all CSS |
| `docker-compose.yml` / `docker-stack.yml` | Local dev / Swarm deployment |
| `.github/workflows/deploy.yml` | Test, build, push images, deploy |

## API (all under /api; everything except /auth/* and /health needs `Authorization: Bearer <token>`)

- `POST /auth/register`, `POST /auth/login` → `{token, user}`
- `GET|POST /courses`, `PUT|DELETE /courses/:id`
- `GET /assignments` (`?course_id&status&from&to`), `GET /assignments/upcoming?days=14`, `GET /assignments/overdue`
- `GET|POST /assignments`, `GET|PUT|DELETE /assignments/:id`
- `GET|POST /assignments/:id/subs`, `PUT|DELETE /assignments/:id/subs/:subId`

Progress is recomputed from sub-tasks whenever one changes. With no sub-tasks, progress and status are set manually.

## Swarm deployment

1. Create 2-3 Droplets with Docker; open ports 2377/tcp, 7946/tcp+udp, 4789/udp between them.
2. Manager: `docker swarm init --advertise-addr <private-ip>`; workers run the printed `join` command.
3. Attach a DigitalOcean Volume to one Droplet, mount it at `/mnt/pgdata`, then `mkdir /mnt/pgdata/postgres`.
4. Label that node: `docker node update --label-add db=true <node-name>` (the stack pins Postgres there).
5. Copy `.env.example` to `~/.env` on the manager and fill it in (including `REGISTRY_USER`).
6. Push images (`docker build -t USER/tracker-backend ./backend && docker push ...`, same for frontend), or let CI do it.
7. Deploy: `set -a; . ./.env; set +a; docker stack deploy -c docker-stack.yml --with-registry-auth tracker`
8. Persistence test: add data, `docker stack rm tracker`, redeploy, confirm the data is still there.

## Monitoring

Enable DigitalOcean Monitoring on each Droplet and add alerts (CPU > 80%, memory > 85%, disk > 80%).
App logs: `docker service logs -f tracker_backend` (also `tracker_notifier`).
