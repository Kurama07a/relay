# Relay

A Slack bot that keeps client requests and engineering work in sync, without
anyone copy-pasting between channels.

A client asks for something in their channel. Relay posts it into your
engineering channel. Someone reacts to claim it. From that thread the team
reports progress and asks follow-up questions — and every one of those lands
back in the client's original thread automatically.

**Status: v0.** Deliberately small. See [What's not in v0](#whats-not-in-v0).

---

## The flow

```
CLIENT CHANNEL                    INTERNAL CHANNEL
──────────────                    ────────────────

Jane: "checkout is broken,
       throws a 500"
      👀  ← seen                  🐞 REL-7 · Bug
                                  > checkout is broken, throws a 500
                                  From Jane in #acme  ·  🆕 Needs triage
                                  React ✋ to claim  ·  ❌ to dismiss

                                        ✋  ← Sam reacts

  └─ "👋 Sam has picked this        └─ "✋ Sam has this one."
      up — tracked as REL-7"
                                        Sam: !start
  └─ "🔧 Sam has started work
      on REL-7"                         Sam: !ask which browser?

  └─ "❓ Sam has a question:
      which browser?"

  Jane: "Safari 17"  ──────────►    └─ "💬 Jane replied: Safari 17"

                                        Sam: !done shipped in v2.4.1
  └─ "✅ REL-7 is done —
      shipped in v2.4.1"
```

The client never leaves their thread. The team never leaves theirs.

## Triage

Every new top-level message in a watched client channel gets relayed to the
internal channel with ✋ and ❌ already attached:

- **✋ react** — claims it. Creates the task, assigns it to you, and tells the
  client who picked it up.
- **❌ react** — dismisses it. No task, and *the client is not notified* — this
  is for "thanks!" and other chatter, not for saying no.

Removing your ✋ before you've started releases the task back to triage. Once
you've run `!start` it stays yours; use `!assign` to hand it off.

If the channel is chattier than you want, set `INGEST_MODE=mention` and Relay
will only pick up messages that @-mention it.

## Thread commands

Run these in the relayed message's thread in the internal channel.

| Command | Effect | Client sees |
|---|---|---|
| `!start` | Starts the clock (and claims it if nobody has) | 🔧 *Sam has started work* — first time only |
| `!pause` | Stops the clock; task stays open | — nothing |
| `!done [note]` | Marks finished | ✅ *REL-7 is done — note. It took about 4 hours.* |
| `!block <why>` | Marks blocked | ⛔ *REL-7 is blocked — why* |
| `!unblock` | Resumes | ▶️ *unblocked and moving again* |
| `!ask <question>` | Asks the client in their thread | ❓ *Sam has a question…* |
| `!reply <message>` | Sends an update, no question implied | 💬 *Sam on REL-7…* |
| `!note <text>` | Records an internal note | — nothing |
| `!assign @teammate` | Hands it over | 🔄 *now with Priya* |
| `!kind bug\|feature\|review\|question\|request` | Fixes the category | — nothing |
| `!time -30 <why>` | Corrects the running session, in minutes | — nothing |
| `!sessions` | Who worked on it and for how long | — nothing |
| `!status` | Full history in-thread | — nothing |
| `!help` | Command list (only you see it) | — nothing |

**Anything that isn't a command stays internal.** Ordinary thread chatter is
never forwarded — reaching the client is always a deliberate `!ask` or `!reply`.
That's the one rule worth telling the team on day one.

Successful commands get a ✅ reaction rather than a reply, to keep threads
readable. `!note` gets a 🔒 instead, confirming it stayed internal.

## From the editor, without opening Slack

Most of the friction left in the loop above is the trip to Slack itself. Relay
exposes the same operations over a small HTTP API on localhost, driven by a
zero-dependency CLI, so an engineer can work entirely from their terminal:

```bash
relay tasks unclaimed        # what nobody has picked up
relay claim REL-7            # assign it to yourself — client is told
relay start REL-7            # start the clock
relay stop                   # pause; the task stays open
relay done REL-7 "fixed it"  # finish; client hears the rounded time
relay ask REL-7 "which browser?"
```

Everything routes through Relay, so Slack stays in step automatically — the
internal card updates, and the client's thread gets the same messages it would
have if the work had been driven from Slack.

**As a skill.** [`skill/SKILL.md`](skill/SKILL.md) teaches Claude Code the
workflow above. Copy it to `.claude/skills/relay/SKILL.md` and Claude can
answer "what's on my plate", pick up a task, and report progress without being
told the commands.

**Session timing is automatic.** Wire up
[`skill/hooks.example.json`](skill/hooks.example.json) and `SessionEnd` closes
the work session when the editor quits, while `PostToolUse` keeps it alive
while you're actually working. Nobody has to remember to stop a timer.

### How time is tracked

A task accumulates many **work sessions** across its life. Closing a session
never closes the task — that only happens when someone explicitly runs `done`.
So the natural rhythm of stopping for the day and picking it up again on
Thursday is just two sessions on one open task.

Guardrails, because auto-tracked numbers eventually reach a client:

- **One clock per engineer.** Starting a second task pauses the first, so two
  timers can never run at once.
- **Abandoned sessions get reaped.** No heartbeat for 20 minutes and the
  session is closed *and backdated to its last heartbeat* — a laptop that shut
  at 6pm stops counting at 6pm, not whenever the reaper noticed.
- **Corrections are first-class.** `relay time -90 "lunch"` or `!time -90`
  adjusts the running session before anyone signs off on the number.

### What the client sees

Nothing, until the task is done. Then a **rounded** figure — *"about 4 hours"*,
never *"4h 22m"*. Precise numbers invite a line-item argument about work that
was already agreed, and once a client has seen them you can't quietly stop.

The team keeps the exact data: `!sessions` shows the per-session breakdown, who
worked on it, and what the client would be told, so estimation and capacity
planning run off real figures.

## Setup, from inside Slack

```
/relay setup
```

Channel pairings and the spreadsheet link live in the database, not `.env`, and
are managed from Slack. `/relay setup` shows the current configuration with
buttons: **Add pairing** opens a form with two channel pickers, **Connect
sheet** takes a pasted Google Sheets URL.

```
Relay setup

Channel pairings
#acme-corp   →  #eng-acme          Acme Corp · all messages
#globex      →  #eng-shared        Globex · only when @-mentioned
#initech     →  #eng-shared        Initech · all messages

Google Sheet
Open spreadsheet

[ Add pairing ]  [ Change sheet ]  [ Sync now ]
```

**Each client channel routes to its own team channel**, so several clients can
run side by side — sharing one internal channel or having their own. Ingest mode
is per pairing too: a chatty channel can be mention-only while a quiet one
relays everything.

Text equivalents, if you prefer typing:

```
/relay pair #acme-corp #eng-acme     pair two channels
/relay unpair #acme-corp             stop relaying a channel
/relay sheet <url>                   connect a spreadsheet
/relay sheet sync                    push now
/relay backfill                      resolve any leftover user/channel IDs
/relay control #relay-controls       announce config changes there
```

Set a **control channel** and every configuration change gets announced in it,
so there's a shared record of who paired what and when.

### Who can change it

Repointing a client channel is a destructive act, so configuration is gated on
two independent conditions — **who** you are, and **where** you're standing.

Out of the box, any Slack workspace admin can configure Relay and ordinary
members cannot. Naming explicit admins narrows it further:

```
/relay admins                    who can configure Relay, and from where
/relay admin add @lead @ops
/relay admin remove @lead
/relay admin only #relay-controls   restrict setup to one channel
/relay admin anywhere               lift the channel restriction
/relay admin reset                  back to "any workspace admin, anywhere"
```

Or use the **Permissions** button on the setup card, which opens a form with a
people picker and a channel picker.

Three rules stop this becoming a way to lock yourself out:

- **Workspace owners always qualify**, whatever the lists say. They can
  reinstall the app anyway, so this grants nothing they didn't have — but it
  guarantees somebody can always fix a bad configuration.
- **Granting admin keeps you an admin.** You can't hand the keys over and
  accidentally exclude yourself in the same action.
- **You can't remove the last admin.** Add a replacement first, or `reset`.

Task commands (`/relay`, `/relay mine`, `/relay stats`) stay open to everyone.
`/relay setup` is also readable by anyone — knowing which team channel your
requests land in is useful — but non-admins see it without the spreadsheet link
and without the buttons.

Gating is enforced on the interaction payloads too, not just on the buttons
being drawn. A hidden button is a UI convenience, not an authorisation model.

Pairings are validated as they're made: Relay checks it's actually a member of
both channels and refuses combinations that would loop or double-post — pairing
a channel with itself, or making a team channel double as a client channel.

`.env` keeps only what belongs to the machine: tokens, database path, log level,
and the Google service account key. Anything about how the team works is
configured in Slack.

> Upgrading from an older install? `CLIENT_CHANNELS` and `INTERNAL_CHANNEL` are
> copied into the database automatically on first run, then ignored. Nothing
> changes, and you can delete them from `.env`.

## The ledger

```
/relay           open tasks
/relay mine      tasks assigned to you
/relay all       everything, newest first
/relay done      recently completed
/relay stats     counts by status
/relay REL-7     detail for one task
```

Everything lives in a local SQLite file (`relay.db` by default): tasks plus an
append-only event log of every claim, status change, question, and note.

Statuses: `triage → open → in_progress → done`, with `blocked` and `dismissed`
off to the side.

## Spreadsheets

For people who don't live in Slack — account managers, whoever does capacity
planning — the ledger exports to four tabs: **Summary**, **Tasks**, **Sessions**,
**Activity**.

```bash
npm run export              # -> ./export/*.csv, opens in Excel or Sheets
npm run export -- --out .   # somewhere else
```

No Slack connection or tokens needed; it reads the database directly. User and
channel IDs are rendered as real names, resolved once and cached, so the sheet
says "Sam Patel" and "#acme-corp" rather than `U0BQF6LKRBP`.

Effort appears twice per row on purpose: `Effort` as `4h 22m` to read, and
`Effort (hours)` as `4.37` so the spreadsheet can sum and average it.

### Live Google Sheet

```
/relay sheet connect
```

One click. Relay creates a spreadsheet in the user's Google Drive and keeps it
current — no Google Cloud project, no service account, no JSON key, no sharing
step on their side.

**Workspaces never touch Google Cloud. The operator registers Relay once.**
This is the same shape as the Slack app itself: registered once by whoever ships
it, installed by everyone else.

Operator setup, one time:

1. Google Cloud → **APIs & Services → Credentials → Create credentials →
   OAuth client ID → Web application**
2. Authorised redirect URI: `<PUBLIC_URL>/oauth/google/callback`
3. Enable the **Google Sheets API** and **Google Drive API**
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `PUBLIC_URL` in `.env`

Two decisions worth understanding, because they're what makes this shippable:

- **Relay creates the spreadsheet** rather than accepting a link to an existing
  one. That means the `drive.file` scope suffices — Relay can touch only the
  file it created and nothing else in the user's Drive.
- **`drive.file` is non-sensitive.** The broader `spreadsheets` scope is
  classified sensitive by Google, which forces a verification review (demo
  video, privacy policy, homepage) before external launch, caps you at 100
  users until it passes, shows an "unverified app" warning, and **expires
  refresh tokens every seven days**. Avoiding that scope avoids all of it.

Relay re-syncs whenever something changes (polled every `SHEETS_SYNC_SECONDS`,
default 120; nothing is sent when nothing changed). Tokens refresh
automatically and are persisted, so a restart doesn't force re-authorisation.

The older service-account path still works and takes precedence only if no
workspace account is connected — existing single-team installs keep running
unchanged.

**The sheet is a mirror, not a second source of truth.** Sync is one-way and
edits made in the spreadsheet are overwritten. That's deliberate: task rows
carry the Slack message mapping the whole bot depends on, and letting a
spreadsheet become authoritative over those would mean a stray paste could
permanently detach a card from its client thread. Change tasks from Slack or the
CLI; read them anywhere.

## Setup

See **[SETUP.md](SETUP.md)** — about ten minutes. The included
`manifest.json` defines the whole Slack app, via either the `slack` CLI
(`slack login && slack install`) or a paste into the web dashboard.

To run it on a server, see **[DEPLOY.md](DEPLOY.md)** — `Dockerfile` and
`docker-compose.yml` are in the root, and Google credentials are scripted:

```bash
npm run setup:google     # gcloud only, no console clicking
```

```bash
npm install
cp .env.example .env    # then fill it in
npm run channels        # prints channel IDs for .env
npm run dev
```

Socket Mode, so there's no public URL, no ngrok, and no inbound firewall rule.

## Layout

```
src/
  config.ts        env parsing + validation
  db.ts            sqlite schema
  store.ts         task + event queries
  sessions.ts      work sessions, effort totals, reaper, duration formatting
  tokens.ts        hashed API tokens for the editor CLI
  classify.ts      bug/feature/review keyword routing
  api.ts           HTTP surface for the CLI and skill
  slack/
    app.ts         bolt app (socket mode)
    ingest.ts      client message → internal channel
    reactions.ts   claim / dismiss / release
    thread.ts      !commands
    work.ts        session lifecycle + what the client hears about it
    actions.ts     shared status-transition + notify logic
    commands.ts    /relay ledger views
    design.ts      the visual language: stripe colours, icons, text helpers
    blocks.ts      the internal triage card
    notices.ts     everything the bot says in a client's thread
    names.ts       user + channel name cache
    messages.ts    narrows Slack's message event to "a human said something"
bin/
  relay.mjs        the engineer-facing CLI (no dependencies, no build)
skill/
  SKILL.md         the Claude Code skill
  hooks.example.json  automatic session start/stop
scripts/
  list-channels.ts channel ID helper
  mint-token.ts    issue / list / revoke API tokens
  doctor.ts        checks a live config against what Slack actually granted
  preview.ts       renders every card + notice, no Slack needed
  smoke.ts         ledger, sessions, rounding, tokens — no Slack needed
  api-smoke.ts     the real API + CLI, with Slack deliberately unreachable
```

## Look and feel

```bash
npm run preview          # Block Kit Builder links for every state
npm run preview -- --json
```

Two surfaces, deliberately different voices.

**The internal card** is a triage instrument built for a channel with twenty of
them stacked up. The request title is the only thing at full size; everything
else is small grey context. A coloured stripe down the left edge carries status
— amber needs someone, blue has an owner, cyan is moving, red is stuck, green is
done — so triage becomes a colour scan rather than a reading task.

```
┃ 🐞  Checkout is broken
┃ REL-7 · Bug · Jane Doe in #acme-corp
┃
┃ > the checkout page is broken, throws a 500 on submit
┃
┃ 🔧 In progress · @sam · 🟢 active now · 1h 22m
┃ [ Open in #acme-corp ]
┃ !start !pause !done !ask !block !help
```

**The client thread** never sees any of that. No status names, no commands, no
"assignee" — just a sentence a person could have written, with the ticket
reference demoted to grey text in case they need to quote it.

```
👋 Sam is picking this up.
   I'll post updates here as it moves.
   REL-7

✅ Done — fixed the timeout on CSV export.
   Sam · about 4 hours
```

`design.ts` holds the whole vocabulary — stripe colours, kind icons, action
icons. Slack gives you no CSS and one colour affordance, which is exactly why
the vocabulary is defined once instead of per message.

Every status change goes through `transition()` in `actions.ts`, which writes
the row, logs the event, re-renders the internal message, and notifies the
client. Adding a status means adding it there, and both sides stay in sync.

## Notes on the design

**Names, not mentions, in client channels.** A `<@U123>` mention of an internal
teammate doesn't resolve for people on the far side of a Slack Connect channel —
they'd see a raw ID. Relay resolves display names before writing outward.

**Redelivery is safe.** Slack retries events it thinks you missed. A unique
index on `(client_channel, client_ts)` means a redelivered message can't be
relayed twice.

**The relayed message is always current.** Status and assignee are re-rendered
in place on every change, so the top of the thread is the task's real state.

**Internal announcements are best-effort; client messages are not.** If Slack
is unreachable, `relay done` still commits and logs the failure — the ledger
shouldn't lose work because a notification bounced. But `relay ask` reports an
error, because there delivery *was* the operation.

**The API can't be exposed unauthenticated by accident.** Binding to anything
other than loopback forces token auth on, as does minting the first token.

## What's not in v0

Called out so the gaps are known, not discovered:

- **One internal channel.** All clients route to the same place. Per-client
  routing is a config-shape change, not an architectural one.
- **No due dates, priorities, or SLAs.**
- **Time is wall-clock, not attention.** A session running while you read email
  counts. The heartbeat and `time` corrections narrow this, they don't fix it.
- **No per-client or per-engineer reporting yet.** The data is all in
  `work_sessions`; nothing aggregates it into a view.
- **No edit/delete tracking.** Editing a client message after it's relayed
  doesn't update the relay.
- **No reminders or nudges** for tasks sitting in triage.
- **No web UI** — the ledger is `/relay` and the SQLite file.
- **Single instance.** SQLite and Socket Mode both assume one process. Fine for
  a team; not horizontally scalable as-is.
- **Dismissals are silent.** By design, but it means a client whose request is
  dismissed hears nothing at all.
