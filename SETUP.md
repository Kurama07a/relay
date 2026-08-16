# Setting up Relay

Roughly ten minutes. You need permission to install an app into your Slack
workspace — if you don't have it, an admin will need to approve step 1.

> ### Testing the Slack workflow first?
>
> Do it in a **throwaway Slack workspace** with two channels you invent
> (`#test-client` and `#test-eng`), not in a real client channel. Relay reacts
> 👀 to client messages and posts on your team's behalf the moment it starts —
> that is not something to discover in front of a customer.
>
> Nothing requires the "client" side to be a real client or a Slack Connect
> channel. Any two channels work, and you can play both roles yourself: post as
> you in `#test-client`, react as you in `#test-eng`.
>
> Set `API_ENABLED=false` in `.env` for this phase. The editor CLI and skill
> (step 7) are a separate concern; leave them switched off until the Slack loop
> behaves.

## 1. Create the Slack app

[`manifest.json`](manifest.json) defines the whole app — every scope, event
subscription, and the `/relay` command — so there is nothing to configure by
hand either way. Pick a path:

### Path A — Slack CLI (recommended if you'll iterate on the app)

Install the CLI from <https://tools.slack.dev/slack-cli/>, then from this
directory:

```bash
slack login          # paste the /slackauthticket command it gives you into Slack
slack install        # creates the app from manifest.json and installs it
```

> **Windows: check which `slack` you're running.** The Slack *desktop app*
> installs as `Slack.exe` and often sits earlier on `PATH`, so `slack` may open
> the chat client instead of the CLI. Verify with:
>
> ```powershell
> Get-Command slack | Select-Object -ExpandProperty Source
> ```
>
> If it points at `WindowsApps\Slack.exe`, either call the CLI by its full path
> or turn the alias off in **Settings → Apps → Advanced app settings → App
> execution aliases**.

Why bother: `manifest.json` stays the source of truth in version control. Change
a scope, run `slack app settings` (or reinstall), and the app follows — no
clicking through the dashboard, and no drift between what the repo says and
what Slack actually granted.

Two things the CLI does *not* do here, worth knowing up front:

- **`slack deploy` will not host Relay.** That command is for Deno "run on
  Slack" apps. Relay is a Node process you host yourself — see
  [Hosting it](#hosting-it).
- **`slack run` creates a separate *dev* app** (its own bot user, name suffixed
  `(dev)`, its own tokens injected automatically). That's useful — you can
  develop without touching the installed app — but the dev bot must be invited
  to your channels separately, and it will not see messages the production bot
  sees.

### Path B — the web dashboard

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace.
3. Switch the format toggle to **JSON**, paste [`manifest.json`](manifest.json),
   and create the app.

## 2. Get the two tokens

Skip this if you used `slack run` in step 1 — the CLI injects both tokens for
you, and `dotenv` won't overwrite them.

**Bot token** — *OAuth & Permissions* → **Install to Workspace** → approve.
Copy the **Bot User OAuth Token** (`xoxb-…`).

**App-level token** — *Basic Information* → **App-Level Tokens** → **Generate
Token and Scopes**. Name it anything, add the **`connections:write`** scope,
generate, and copy it (`xapp-…`). This is what Socket Mode uses; it is not the
same as the bot token.

### What the manifest asks for, and why

| Scope | Needed for |
|---|---|
| `channels:history`, `groups:history` | reading messages in the client and internal channels |
| `channels:read`, `groups:read` | resolving channel names, and the startup membership check |
| `chat:write` | posting relays, thread updates, ephemeral errors |
| `reactions:read`, `reactions:write` | the claim/dismiss triage reactions and command acknowledgements |
| `users:read` | showing real names instead of raw user IDs |
| `commands` | the `/relay` slash command |

Bot events: `message.channels`, `message.groups`, `reaction_added`,
`reaction_removed`.

## 3. Configure

```bash
npm install
cp .env.example .env
```

Put both tokens in `.env`, then find your channel IDs:

```bash
npm run channels
```

That prints every channel the bot can see, flagged with whether the bot is
already a member:

```
CHANNEL              ID           FLAGS
--------------------------------------------------
eng-inbox            C0123ABCD    bot-is-member
acme-corp            C0456EFGH    NOT-A-MEMBER slack-connect
```

Fill in `.env`:

```
INTERNAL_CHANNEL=C0123ABCD
CLIENT_CHANNELS=C0456EFGH,C0789IJKL
```

## 4. Invite the bot

In **every** channel from step 3 — the internal one and each client channel:

```
/invite @Relay
```

This is the step people miss. Relay receives no events at all from a channel it
isn't in, and there's no error to see. On startup Relay checks each configured
channel and logs a warning for any it can't read:

```
WARN  bot is not a member of C0456EFGH (#acme-corp) — run /invite @relay there
```

For **Slack Connect** channels, invite the bot from your side. External members
don't need to do anything, and they'll see it join.

> Worth telling clients the bot is there. It reacts 👀 to their messages and
> posts on your team's behalf, so it shouldn't be a surprise.

## 5. Run it

```bash
npm run dev
```

Or, if you're using the CLI and want its dev app and injected tokens:

```bash
slack run
```

Both start the same process — `.slack/hooks.json` points the CLI's `start` hook
at `npm run dev`. The difference is only where the tokens come from: `slack run`
puts them in the environment, and `dotenv` leaves existing environment variables
alone, so they take precedence over anything in `.env` without you editing
files. Everything else (`INTERNAL_CHANNEL`, `CLIENT_CHANNELS`, `DB_PATH`) still
comes from `.env` either way.

You should see:

```
INFO  relay is up (socket mode)
INFO  ingest=all claim=:raised_hand: dismiss=:x: prefix=!
INFO  watching #eng-inbox
INFO  watching #acme-corp
```

## 6. Check it end to end

1. Post a message in a client channel: *"the export button is broken"*.
2. It should get a 👀 reaction, and a `🐞 REL-1 · Bug` card should appear in
   your internal channel with ✋ and ❌ already on it.
3. React ✋ on the card. You get assigned; the client's thread gets *"👋 …has
   picked this up — tracked as REL-1"*.
4. In the card's thread, run `!start`, then `!done fixed`.
5. Check the client thread — it should have the full sequence.
6. Run `/relay` to see the ledger.

Then delete the test task's messages if you ran this in a live client channel.

## 7. Wire up Claude Code / Codex (optional)

This is what removes the trip to Slack entirely. Relay serves an API on
`127.0.0.1:3737` by default; the `relay` CLI talks to it.

**Make the CLI available:**

```bash
npm link          # from this directory, puts `relay` on your PATH
relay me          # should print your name and "no session running"
```

**Tell it who you are.** Slack profile → **More** → **Copy member ID**:

```bash
# add to your shell profile
export RELAY_USER=U0123ABCD
```

**Install the skill** so Claude Code knows the workflow:

```bash
mkdir -p ~/.claude/skills/relay
cp skill/SKILL.md ~/.claude/skills/relay/SKILL.md
```

**Automate session timing** by merging `skill/hooks.example.json` into
`~/.claude/settings.json`. `SessionEnd` is the important one — it stops the
clock when you quit, so you never have to remember to.

Try it:

```bash
relay tasks unclaimed
relay start REL-1
relay stop
```

### If engineers are not on the same machine as Relay

The default is loopback-only and unauthenticated, which is right for a single
machine. To let a team reach a shared Relay, mint a token per engineer:

```bash
npm run token -- --user U0123ABCD --label "sam-laptop"
```

Then set `API_HOST=0.0.0.0` (or a specific interface / Tailscale address) and
restart. Each engineer sets:

```bash
export RELAY_URL=http://relay.internal:3737
export RELAY_TOKEN=relay_xxxxxxxx
```

Two things happen automatically, by design:

- **Minting the first token switches the API into authenticated mode.** Every
  caller then needs one, including anything on the server itself.
- **Binding to a non-loopback address requires tokens** whether or not you've
  minted any — so the API cannot end up on a network with no auth.

Relay speaks plain HTTP. Put it on a private network (VPN, Tailscale) or behind
a TLS-terminating proxy; don't expose it to the internet as-is.

`npm run token -- --list` and `--revoke <id>` manage tokens after the fact.

## Hosting it

`npm run dev` is fine while you're testing, but it dies with your terminal. For
anything ongoing:

```bash
npm run build
npm start
```

Relay uses **Socket Mode**, which changes the hosting problem completely: it
opens an outbound WebSocket to Slack and needs no public URL, no domain, no TLS
certificate, and no inbound firewall rule. It will happily run behind NAT, on a
laptop, or on a machine in your office.

### Four requirements

1. **Always on.** Socket Mode is a persistent connection. Anything that
   scales to zero or sleeps when idle will silently stop relaying.
2. **Exactly one instance.** Two processes both connect and both relay, so
   every client request gets posted twice. No autoscaling, no rolling deploys
   that briefly run two copies — set min and max instances to 1.
3. **A persistent disk for `relay.db`.** This is not just history: it holds the
   mapping between client messages and internal ones. Lose it and every
   existing thread stops working, permanently. It must survive restarts and
   redeploys.
4. **Outbound internet.** That's all.

### What this rules out

**Serverless is fundamentally incompatible** — Vercel, Netlify, Lambda,
Cloudflare Workers, Cloud Run with scale-to-zero. They fail requirement 1 (no
long-lived process), and their filesystems fail requirement 3. Don't try to
make Relay fit them; it would need rewriting as an HTTP-events app with a
hosted database, which is a different project.

Free tiers that sleep after inactivity (Render's free web services, similar)
fail for the same reason.

### What works

| Option | Cost | Notes |
|---|---|---|
| **Your laptop** | free | Correct for phase 1. Offline when closed — see the caveat below. |
| **A small VPS** (Hetzner, DigitalOcean, Vultr) | ~$4–6/mo | Simplest mental model. `systemd` unit, `relay.db` on the normal disk, done. What I'd pick for a small team. |
| **Fly.io** | ~$2–5/mo | Run it as a process with no exposed ports; attach a volume for `relay.db`. Good if you'd rather not manage a box. |
| **Railway / Render (paid worker)** | ~$5–7/mo | Works with a persistent volume attached. Check the plan actually offers one. |
| **A spare machine or Pi in the office** | free | Perfectly viable, since no inbound access is needed. |

Prices drift — treat them as ballpark and check current rates.

Keep it alive with whatever you already use: `systemd`, `pm2`, or a container
with `restart: unless-stopped`. Relay exits non-zero on a fatal error, so a
supervisor will restart it cleanly.

### Events are not queued while it's down

This is the one that surprises people. If Relay is not connected, Slack has
nowhere to deliver to, and **messages sent during the outage are missed** — they
are not replayed on reconnect. There is no catch-up.

Practically: a laptop that closes overnight will not pick up what a client
posted at 9am. That's fine for testing, and it's the main reason to move to an
always-on host before real clients depend on it. Restarts are fine — a few
seconds of downtime during a deploy is very unlikely to land in the middle of a
message.

### Backups

`relay.db` is a single SQLite file. A nightly copy somewhere else is enough:

```bash
sqlite3 relay.db ".backup '/backups/relay-$(date +%F).db'"
```

Use `.backup` rather than `cp` — it's safe to run against a live database,
whereas copying a file mid-write can capture a torn state.

## Troubleshooting

**Nothing happens when a client posts.**
The bot isn't in the channel (step 4), the channel ID isn't in `CLIENT_CHANNELS`,
or `INGEST_MODE=mention` is set and the message didn't @-mention the bot. Start
with `LOG_LEVEL=debug`.

**A message from earlier never got relayed.**
Relay was down when it was posted. Slack does not replay Socket Mode events, so
there is nothing to recover — ask the client to repost, or relay it by hand.
This is the cost of hosting it somewhere that isn't always on.

**`not_in_channel` when posting.**
The bot isn't in the internal channel. `/invite @Relay` there.

**Reacting ✋ does nothing — but relaying works.**

Run `npm run doctor` first; it checks the four causes below against your live
config and token. In order of likelihood:

1. **`reactions:read` was never granted.** Adding a scope in the dashboard does
   nothing until you **reinstall** the app. Without this scope Slack never
   delivers the event, so the bot cannot know you reacted. `npm run doctor`
   compares granted scopes against the required set.

2. **A different emoji than the one configured.** Slack reports the same glyph
   under different names depending on which client added it — ✋ arrives as
   either `raised_hand` or `hand` — so known aliases are accepted
   automatically and `npm run doctor` prints the full accepted set. But a
   genuinely different emoji does nothing: 🙋 is `raising_hand` and 👋 is
   `wave`, neither of which claims. The log says which arrived:

   ```
   INFO  ignoring :wave: on REL-3 — claim accepts :raised_hand:/:hand:, dismiss accepts :x:
   ```

   Add it with `CLAIM_EMOJI=raised_hand,point_up` if you want another to work.

3. **`INTERNAL_CHANNEL` is a DM.** Relay subscribes to `message.channels` and
   `message.groups` only, so a direct message — including the "note to self" DM
   — delivers no reaction events at all, even though posting into it works
   fine. That combination looks exactly like this bug: relays appear, reactions
   do nothing. Use a real channel, public or private.

4. **`INTERNAL_CHANNEL` is a name, not an ID.** `chat.postMessage` accepts
   `#some-channel`, so relaying works, but the incoming reaction event carries
   the channel *ID* and won't match. It must be the `C…`/`G…` ID.

Then run with `LOG_LEVEL=debug`. Every reaction the bot decides to ignore now
says why:

```
INFO  ignoring :thumbsup: on REL-1 — claim is :raised_hand:, dismiss is :x:
DEBUG ignoring :raised_hand: in D09ABC — not the internal channel (C08XYZ)
```

If you see *no* line at all when you react, the event isn't arriving — that's
cause 1 or 3, not a configuration mismatch.

**Reactions on the client's original message do nothing.** That's by design —
only the relayed card in the internal channel is a triage surface.

**`missing_scope`.**
The app was installed before a scope was added. Reinstall from *OAuth &
Permissions* → **Reinstall to Workspace**.

**Commands do nothing in the thread.**
They only work in the internal channel, in the thread under a relayed card, and
must start at the very beginning of the message: `!start`, not `ok !start`.

**`relay` says "Cannot reach Relay".**
The Relay process isn't running, or `RELAY_URL` points somewhere else. Check
`curl http://127.0.0.1:3737/health`. If Relay is on another machine, remember
that `API_HOST` must not be `127.0.0.1` there.

**`relay` says "No identity".**
Set `RELAY_USER` to your Slack member ID, or `RELAY_TOKEN` if the server
requires one.

**Time looks far too high on a task.**
Someone's session was left running. `!sessions` in the task's Slack thread shows
each session and flags the ones that were auto-closed. Correct the running one
with `!time -120 "left it open overnight"` before marking it done — the client
only ever sees the total, and only at completion.

**Verify the non-Slack parts are sane:**

```bash
npm test
```

Runs 98 checks — ledger, classifier, work sessions, the reaper, duration
rounding, token auth, plus the real HTTP API and CLI end to end. No Slack and no
tokens needed.
