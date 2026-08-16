# Relay

A Slack bot that keeps client requests and engineering work in sync, without
anyone copy-pasting between channels.

A client asks for something in their channel. Relay posts it into your team's
channel as a triage card. Someone reacts to claim it. From there the team
reports progress, asks follow-up questions, and tracks how long the work takes —
and every update lands back in the client's original thread automatically.

---

## The flow

```
CLIENT CHANNEL                    TEAM CHANNEL
──────────────                    ────────────

Jane: "checkout is broken,
       throws a 500"
      👀  ← seen                  🐞  Checkout is broken
                                  REL-7 · Bug · Jane in #acme
                                  > checkout is broken, throws a 500
                                  🆕 Needs triage · unassigned
                                  React ✋ to claim · ❌ to dismiss

                                        ✋  ← Sam reacts

  └─ "👋 Sam is picking this        └─ "🙌 Sam has this one."
      up. I'll post updates
      here as it moves."                 Sam: !start

  └─ "🔧 Sam has started
      on this."                          Sam: !ask which browser?

  └─ "❓ Sam asks:
      which browser?"

  Jane: "Safari 17"  ──────────►    └─ "💬 Jane replied: Safari 17"

                                        Sam: !done fixed the timeout
  └─ "✅ Done — fixed the
      timeout.
      Sam · about 2 hours"
```

The client never leaves their thread. The team never leaves theirs.

## Triage

Every new top-level message in a paired client channel is relayed as a card,
with ✋ and ❌ already attached:

- **✋** claims it — creates the task, assigns it to you, and tells the client
  who picked it up.
- **❌** dismisses it — no task, and the client is not notified. This is for
  "thanks!" and other chatter.

Removing your ✋ before you've started releases the task back to triage. Once
you've started it stays yours; use `!assign` to hand it off.

Slack reports the same emoji under different names depending on the client, so
✋ is accepted as either `raised_hand` or `hand`. A reaction outside the claim
and dismiss sets is ignored and logged with the name that arrived.

## The card

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

The request title is the only thing at full size; everything else is small grey
context. A coloured stripe down the left edge carries status — amber needs
someone, blue has an owner, cyan is moving, red is stuck, green is done — so
triage is a colour scan rather than a reading task.

The card is re-rendered on every change, so the top of the thread is always the
task's real state.

## Thread commands

Run these in the card's thread.

| Command | Effect | Client sees |
|---|---|---|
| `!start` | Starts the clock, claiming it if nobody has | 🔧 *Sam has started on this* — first time only |
| `!pause` | Stops the clock; the task stays open | — nothing |
| `!done [note]` | Marks finished | ✅ *Done — note. Sam · about 2 hours* |
| `!block <why>` | Marks blocked | ⏸️ *On hold — why* |
| `!unblock` | Resumes | ▶️ *Back on this one* |
| `!ask <question>` | Asks the client in their thread | ❓ *Sam asks…* |
| `!reply <message>` | Sends an update, no question implied | 💬 *Sam: …* |
| `!note <text>` | Records an internal note | — nothing |
| `!assign @teammate` | Hands it over | 🔄 *Priya has taken this over* |
| `!kind bug\|feature\|review\|question\|request` | Fixes the category | — nothing |
| `!time -30 <why>` | Corrects the running session, in minutes | — nothing |
| `!sessions` | Who worked on it and for how long | — nothing |
| `!status` | Full history in-thread | — nothing |
| `!help` | Command list (only you see it) | — nothing |

**Anything that isn't a command stays internal.** Ordinary discussion in the
thread is recorded as context but never forwarded — reaching the client is
always a deliberate `!ask` or `!reply`. That's the one rule worth telling the
team on day one.

Successful commands get a ✅ reaction rather than a reply, to keep threads
readable. `!note` gets a 🔒, confirming it stayed internal.

## From the editor

Relay exposes the same operations over a small HTTP API, driven by a
zero-dependency CLI, so an engineer can work without opening Slack:

```bash
relay login --token relay_xxxx   # once per machine

relay tasks unclaimed            # what nobody has picked up
relay show REL-7                 # request, full conversation, time so far
relay claim REL-7                # assign to yourself — the client is told
relay start                      # start the clock
relay done REL-7 "fixed it"      # finish; the client hears the rounded time
relay ask REL-7 "which browser?"
```

Everything routes through Relay, so Slack stays in step automatically — the card
updates and the client's thread gets the same messages it would have if the work
had been driven from Slack.

`relay show` includes the whole conversation: the client's original message,
their replies, questions the team asked, and internal thread notes. That's
usually the part that explains what's actually wanted.

**As a skill.** [`skill/SKILL.md`](skill/SKILL.md) teaches Claude Code the
workflow. Copy it to `~/.claude/skills/relay/SKILL.md` and Claude can answer
"what's on my plate", pick up a task, and report progress without being told the
commands.

### Time tracking, hands off

Wire up [`skill/hooks.example.json`](skill/hooks.example.json) and nobody starts
or stops a timer:

- **SessionStart** resumes whatever you were last doing in that directory
- **PostToolUse** keeps the session alive while you work, throttled to one real
  call every two minutes
- **SessionEnd** closes the session when you quit

`relay start` with no task works out which one you mean, and says why:

```
from your branch name              a branch matching rel-7-*
you were last working on it here   the directory you started it in
it's the only task you have in progress
```

When it's genuinely ambiguous it lists your options rather than guessing.

### How effort is counted

A task accumulates many **work sessions** across its life. Closing a session
never closes the task — only an explicit `done` does that. Stopping for the day
and picking it up on Thursday is two sessions on one open task.

- **One clock per engineer.** Starting a second task pauses the first, so two
  timers can never run at once.
- **Abandoned sessions are reaped.** No heartbeat for 20 minutes and the session
  closes, *backdated to its last heartbeat* — a laptop that shut at 6pm stops
  counting at 6pm, not when the reaper noticed.
- **Corrections are first-class.** `relay time -90 "lunch"` adjusts the running
  session before anyone signs off on the number.

### What the client sees

Nothing about time until the task is done. Then a **rounded** figure — *"about
2 hours"*, never *"2h 14m"*. Precise numbers invite a line-item argument about
work that was already agreed.

The team keeps the exact data: `!sessions` shows the per-session breakdown, who
worked on it, and what the client would be told.

## Setup, from inside Slack

```
/relay setup
```

Channel pairings, the spreadsheet link, and who may configure Relay all live in
the database and are managed from Slack. `/relay setup` shows the current
configuration with buttons: **Add pairing** opens a form with two channel
pickers, **Connect sheet** takes a pasted Google Sheets URL, **Permissions**
takes a people picker and a channel picker.

```
Relay setup

Channel pairings
#acme-corp   →  #eng-acme          Acme Corp · all messages
#globex      →  #eng-shared        Globex · only when @-mentioned
#initech     →  #eng-shared        Initech · all messages

Google Sheet
Open spreadsheet
Syncs automatically · last updated 12s ago

[ Add pairing ]  [ Change sheet ]  [ Sync now ]  [ Permissions ]
```

**Each client channel routes to its own team channel**, so several clients run
side by side — sharing one team channel or having their own. Whether to relay
everything or only @-mentions is set per pairing.

Text equivalents:

```
/relay pair #acme-corp #eng-acme     pair two channels
/relay unpair #acme-corp             stop relaying a channel
/relay sheet <url>                   connect a spreadsheet
/relay sheet sync                    push now · restyle · title <name> · off
/relay backfill                      resolve any leftover user/channel IDs
/relay control #relay-controls       announce config changes there
```

Set a **control channel** and every configuration change is announced in it, so
there's a shared record of who changed what.

Pairings are validated as they're made: Relay checks it's a member of both
channels and refuses combinations that would loop or double-post — pairing a
channel with itself, or making a team channel double as a client channel.

`.env` holds only what belongs to the machine: tokens, database path, log level,
and Google credentials.

### Who can change it

Configuration is gated on two independent conditions — **who** you are and
**where** you're standing.

By default any Slack workspace admin can configure Relay and ordinary members
cannot. Naming explicit admins narrows it further:

```
/relay admins                        who can configure, and from where
/relay admin add @lead @ops
/relay admin only #relay-controls    restrict setup to one channel
/relay admin anywhere                lift the channel restriction
/relay admin reset                   back to "any workspace admin, anywhere"
```

Three rules prevent lockout:

- **Workspace owners always qualify.** They can reinstall the app anyway, so
  this grants nothing new — but it guarantees somebody can fix a bad config.
- **Granting admin keeps you an admin.** You can't hand over the keys and
  exclude yourself in one action.
- **You can't remove the last admin.** Add a replacement first, or `reset`.

Task commands stay open to everyone. `/relay setup` is readable by anyone —
knowing which team channel your requests land in is useful — but non-admins see
it without the spreadsheet link and without the buttons.

Gating is enforced on the interaction payloads, not just on which buttons get
drawn.

## The ledger

```
/relay           open tasks
/relay mine      tasks assigned to you
/relay all       everything, newest first
/relay done      recently completed
/relay stats     counts by status
/relay REL-7     detail for one task
```

Everything lives in a SQLite file (`relay.db`): tasks, work sessions, and an
append-only event log of every claim, status change, question, and note.

Statuses: `triage → open → in_progress → done`, with `blocked` and `dismissed`
off to the side.

## Spreadsheets

For people who don't live in Slack, the ledger exports to four tabs —
**Summary**, **Tasks**, **Sessions**, **Activity**.

```bash
npm run export              # -> ./export/*.csv
npm run export -- --out .   # somewhere else
```

No Slack connection or tokens needed; it reads the database directly. User and
channel IDs are rendered as real names, so the sheet says "Sam Patel" and
"#acme-corp".

Effort appears twice per row on purpose: `Effort` as `2h 14m` to read, and
`Effort (hours)` as `2.23` so the spreadsheet can sum it.

### Live Google Sheet

```
/relay sheet <url>
```

Relay renames the spreadsheet, creates the tabs, styles them, and keeps them
current — checking every 15 seconds and pushing only when something changed.
`/relay sheet` reports when it last updated.

The sheet is styled to match the cards: a merged banner, frozen headers, sized
columns, zebra striping, a filter row, and status cells coloured with the same
palette as the card stripes. Formatting is applied once per style version rather
than on every sync; `/relay sheet restyle` reapplies it.

Setup, on the machine running Relay:

```bash
gcloud auth login
npm run setup:google        # project, APIs, service account, key — no clicking
```

That prints an address ending `iam.gserviceaccount.com`. **Share your
spreadsheet with it as an Editor** — the service account is a separate identity
from your own Google account, so your access grants it nothing. Then set
`GOOGLE_SERVICE_ACCOUNT_FILE` in `.env`, or paste the flattened key
(`npm run google:env`) as `GOOGLE_SERVICE_ACCOUNT_JSON`.

**The sheet is a mirror, not a second source of truth.** Sync is one-way and
edits made in the spreadsheet are overwritten. Task rows carry the Slack message
mapping the whole bot depends on, and letting a spreadsheet become authoritative
over those would mean a stray paste could permanently detach a card from its
client thread. Change tasks from Slack or the CLI; read them anywhere.

## Setup

**[SETUP.md](SETUP.md)** — about ten minutes. `manifest.json` defines the whole
Slack app, via either the `slack` CLI (`slack login && slack install`) or a
paste into the web dashboard.

**[DEPLOY.md](DEPLOY.md)** — running it on a server. `Dockerfile` and
`docker-compose.yml` are in the root.

```bash
npm install
cp .env.example .env    # tokens go here
npm run dev
```

Socket Mode, so there's no public URL, no domain, and no inbound firewall rule.

```bash
npm run doctor          # checks a live config against what Slack granted
npm run channels        # list channel IDs
npm run preview         # render every card and notice, no Slack needed
npm test                # 211 checks, no Slack and no tokens needed
```

## Layout

```
src/
  config.ts        env parsing + validation
  db.ts            sqlite schema
  store.ts         task + event queries
  routes.ts        channel pairings
  settings.ts      runtime config held in the database
  permissions.ts   who may configure Relay, and from where
  sessions.ts      work sessions, effort totals, reaper, durations
  workdirs.ts      directory ↔ task binding, and task inference
  tokens.ts        hashed API tokens for the CLI
  emoji.ts         Slack emoji alias matching
  classify.ts      bug/feature/review keyword routing
  report.ts        flat rows for CSV and Sheets
  sheets.ts        Google Sheets sync
  sheet-style.ts   the spreadsheet's visual design
  google.ts        Google OAuth
  resolve-names.ts backfills user and channel names
  api.ts           HTTP surface for the CLI and skill
  slack/
    app.ts         bolt app (socket mode)
    ingest.ts      client message → team channel
    reactions.ts   claim / dismiss / release
    thread.ts      !commands
    work.ts        session lifecycle and what the client hears about it
    actions.ts     shared status-transition + notify logic
    admin.ts       setup card, modals, migration
    commands.ts    /relay
    design.ts      the visual language: colours, icons, text helpers
    blocks.ts      the triage card
    notices.ts     everything the bot says in a client's thread
    names.ts       user + channel name cache
    messages.ts    narrows Slack's message event to "a human said something"
bin/
  relay.mjs        the engineer CLI (no dependencies, no build)
skill/
  SKILL.md         the Claude Code skill
  hooks.example.json  automatic session start/stop
scripts/
  doctor.ts        checks a live config against what Slack granted
  channels, export, preview, token, setup-google, google-env, push-sheet
  smoke.ts, api-smoke.ts   the test suite
```

Every status change goes through `transition()` in `slack/actions.ts`, which
writes the row, logs the event, re-renders the card, and notifies the client.
Adding a status means adding it there, and both sides stay in step.

## Notes on the design

**Names, not mentions, in client channels.** A `<@U123>` mention of a teammate
doesn't resolve for people on the far side of a Slack Connect channel — they'd
see a raw ID. Relay resolves display names before writing outward.

**Redelivery is safe.** Slack retries events it thinks you missed. A unique
index on `(client_channel, client_ts)` means a redelivered message can't be
relayed twice.

**Internal announcements are best-effort; client messages are not.** If Slack is
unreachable, `relay done` still commits and logs the failure — the ledger
shouldn't lose work because a notification bounced. But `relay ask` reports an
error, because there delivery *was* the operation.

**The API can't be exposed unauthenticated by accident.** Binding to anything
other than loopback forces token auth on, as does minting the first token.

**`relay.db` is not a cache.** It holds the mapping between each client message
and its card. It needs a persistent volume and a backup.
