# Deploying Relay to a VPS with Coolify

Relay reaches Slack over an **outbound** WebSocket (Socket Mode), so it needs no
domain, no public port, and no inbound firewall rule. That makes this simpler
than most deployments — the only thing that genuinely matters is that the
database survives redeploys.

## Before you start

Two facts that shape everything below:

- **`relay.db` is not a cache.** It holds the mapping between each client
  message and its relayed card. Lose it and every existing thread silently stops
  working — the cards stay in Slack, but reactions and commands on them do
  nothing. It must be on a persistent volume.
- **Exactly one instance.** Socket Mode and SQLite both assume a single process.
  Two replicas will relay every client request twice. Don't scale it.

## 1. Google credentials (optional, scripted)

Skip if you don't want the spreadsheet mirror.

```bash
gcloud auth login
npm run setup:google
```

That creates a project, enables the Sheets and Drive APIs, makes a service
account, and writes `gcp-service-account.json` — no console clicking. It prints
an address; share your spreadsheet with it as an **Editor**.

For Coolify, don't copy the file to the server. Flatten it to one line and paste
it as an environment variable instead:

```bash
npm run google:env
```

## 2. Create the app in Coolify

**New Resource → Docker Compose** (or **Dockerfile**), pointed at your Git repo.
Both `docker-compose.yml` and `Dockerfile` are in the root and need no changes.

The image builds in two stages so the C++ toolchain that compiles `better-sqlite3`
is discarded before the final layer. Expect the first build to take a few
minutes and later ones to be fast.

## 3. Persistent storage — the step that matters

**Storages → Add**, mount path:

```
/data
```

If you're using `docker-compose.yml`, the named `relay-data` volume already does
this; confirm Coolify picked it up rather than assuming.

`DB_PATH=/data/relay.db` is already set in the Dockerfile, so nothing else is
needed. Get this wrong and everything works fine until your first redeploy.

## 4. Environment variables

In Coolify's **Environment Variables** tab:

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_APP_TOKEN` | `xapp-…` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the one-line JSON from step 1 (optional) |
| `LOG_LEVEL` | `info` |

Mark the tokens as build-time-secret / hidden if Coolify offers it.

Everything else — channel pairings, the spreadsheet link, who may configure
Relay — is set from Slack with `/relay setup` and lives in the database. You
should not need `CLIENT_CHANNELS` or `INTERNAL_CHANNEL` at all.

## 5. Networking

**Leave the port closed.** Socket Mode is outbound-only, so Relay needs no
domain and no exposed port. Coolify may ask for one; it isn't required, and the
healthcheck runs inside the container.

## 6. Deploy

Watch the logs for:

```
INFO  relay is up (socket mode)
INFO  watching #client
INFO  watching #meeee
```

If it restart-loops with `invalid_auth`, the tokens are wrong or the app was
reinstalled and `SLACK_BOT_TOKEN` is stale.

## Using the CLI from your laptop

The engineer API binds to `127.0.0.1` inside the container, so it isn't reachable
from outside. For personal use the cleanest fix is an SSH tunnel — no exposure,
no tokens, nothing to secure:

```bash
ssh -N -L 3737:127.0.0.1:3737 you@your-vps
```

Then, on your laptop:

```bash
relay login --user U0123ABCDEF    # your Slack member ID
relay tasks mine
```

That only works if the container's port is published to the host. Add to
`docker-compose.yml`:

```yaml
ports:
  - "127.0.0.1:3737:3737"
```

Binding to `127.0.0.1` on the host keeps it off the public internet while
letting the tunnel reach it.

If you'd rather expose it properly instead, set `API_HOST=0.0.0.0`, publish the
port, put it behind Coolify's proxy with TLS, and mint a token:

```bash
docker exec -it <container> node -e "…"   # or run npm run token locally
```

Relay **forces token auth on whenever it binds to a non-loopback address**, so
this cannot be exposed unauthenticated by accident.

## Backups

The ledger is one SQLite file. A nightly copy is enough:

```bash
docker exec <container> sh -c \
  "sqlite3 /data/relay.db \".backup '/data/backup-\$(date +%F).db'\"" 
```

Use `.backup`, not `cp` — copying a live database can capture a torn write. Pull
the result off the volume to somewhere else; a backup that lives only on the
same disk isn't one.

## Updating

Push to your repo and redeploy in Coolify. The database is on a volume, so
schema changes apply automatically on boot (every table is created
`IF NOT EXISTS`, and new columns are additive).

There will be a few seconds of downtime during a redeploy. **Slack does not
replay Socket Mode events**, so a client message sent in exactly that window is
missed — no catch-up, nothing to recover. It's a small window, but deploy when
your clients are quiet rather than mid-conversation.
