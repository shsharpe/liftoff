# Liftoff 2

A self-verifying deployment inspector for cPanel AI App Hosting. Open it after a deploy and it checks, live, that the app is running the way the platform says it is, then lets you look inside the container. Every reading is taken by the server at the moment you load the page. A check that can't be confirmed stays amber.

## What's in it

| Part | What it does |
| --- | --- |
| Route | Six stations: source, framework signal, built separately, container, proxy, HTTPS |
| Live telemetry | Memory (with the container limit marked), CPU and event loop delay for the last two minutes |
| Isolation | User namespace mapping, seccomp, capabilities, cgroup limits, out-of-memory kills, filesystem |
| Network | DNS plus npm, GitHub and Docker Hub reachability, with timings |
| Data | Finds a linked MySQL or MariaDB database and times queries. Shows version and latency only |
| Dependencies | Every installed package counted in the build container, largest first, plus Brotli build output |
| Requests | The last requests the app served. Requests without forwarding headers came from the server itself |
| Demo tools | Round-trip timing, a numbered log line, and a stop-and-recover timer |

## Stack

Fastify 5, with `@fastify/static` (serves the Brotli files the build step makes), `@fastify/helmet` (strict content security policy), `@fastify/rate-limit`, and `mysql2` (pure JavaScript, loaded only when a database is linked). There are no native modules, so the build needs no compiler. The front end has no framework or bundler on purpose.

## Deploy

1. Push this folder to a public GitHub repo.
2. In cPanel (Meridian): Websites & Apps, add a website, Node.js, Git repository, paste the HTTPS URL.
3. Confirm the defaults: build command `npm run build`, start command `npm start`. The app reads `PORT` and falls back to `3000`.

The footer shows the version (2.0.0) and, for Git deploys, the commit on the Runtime panel.

## Settings (App Env tab, then restart)

| Variable | Effect |
| --- | --- |
| `DEMO_BANNER` | Shows a line of your own at the top of the page |
| `DEMO_CRASH=on` | Enables the Stop and recover tool. Off by default |
| `LIFTOFF_PASSCODE` | Locks the inspector behind a passcode |

The inspector shows server internals (host names, user mappings, reachability). If the page is public, set a passcode, or stop the app when you're done.

## Limits worth knowing

- The platform's database variable names aren't documented anywhere I could find. The Data tab accepts the usual conventions (`DATABASE_URL`, `DB_*`, `MYSQL_*`, `MARIADB_*`) and lists the names it saw.
- Stop and recover only works if the platform restarts a stopped app. Press Start in cPanel if it doesn't come back.
- A Git deploy only shows a commit if the clone keeps its `.git` folder.
