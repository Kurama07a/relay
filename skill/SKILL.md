---
name: relay
description: Claim and work client requests from the terminal, with time tracked automatically. Use when the user asks what client requests are waiting, wants to pick one up or assign it to themselves, start working on one, ask the client a question, or mark work finished. Triggers on "what's on my plate", "any new requests", "what did the client say", "assign REL-7 to me", "take that one", "work on it", "mark it done".
---

# Relay

Client requests arrive in Slack. Relay puts them in the terminal, tracks how
long work takes without anyone starting a timer, and posts progress back to the
client automatically.

All state lives in Relay. This skill only calls the `relay` CLI — never edit the
database, and never post to Slack by hand to change a task. The CLI is what
keeps the client's thread, the internal card, and the ledger in step.

## First run on a machine

```bash
relay login --token relay_xxxx        # a hosted Relay
relay login --user U0123ABCD          # a Relay on this same machine
```

Saved to `~/.relay/config.json`. If a command fails with "No identity" or
"Cannot reach Relay", say so and stop — don't retry or work around it.

## Finding work

```bash
relay tasks unclaimed     # nobody has picked these up
relay tasks mine          # already yours
relay show REL-7          # request text, the full conversation, time so far
```

**`relay show` includes the conversation** — the client's original message,
their replies, questions the team asked, and internal thread notes. That is
usually the part that explains what's actually wanted. Read it before starting.
There's no need for a separate Slack integration to see this.

## Taking a task

When the user says "assign REL-7 to me", "I'll take that one", or similar:

```bash
relay claim REL-7
```

That assigns it and tells the client who picked it up. Then read `relay show
REL-7` and summarise what's being asked, flagging anything ambiguous — if the
request is unclear, that's the moment to suggest a `relay ask`, not after an
hour of guessing.

## Working on it

```bash
relay start REL-7      # or just: relay start
```

`relay start` with no task works it out — from a branch named `rel-7-*`, from
what was last worked on in this directory, or from having exactly one task in
flight. It says which it picked and why. When genuinely ambiguous it lists the
options rather than guessing.

**Time tracking is automatic after that.** The editor's hooks keep the session
alive while work happens and close it on exit, and reopening the project resumes
it. Do not run `relay stop` at the end of a working session — the hook handles
it, and stopping manually only matters when switching to something else.

Then do the engineering work as normal.

## Rules that matter

**Never run `relay done` on your own initiative.** Sessions open and close all
day; the task stays open through all of it. Only the user decides something is
finished, and only that command tells the client the work is complete along with
how long it took. If work seems finished, ask.

**`relay ask` reaches the client.** It posts into their own Slack thread. Draft
the question, show it to the user, and let them approve before sending. Anything
not sent with `ask` or `reply` stays internal.

**One clock at a time.** Starting a task pauses any other running session. Say
so when it happens, so the user knows their other timer stopped.

**Time corrections exist.** If the user mentions leaving the session running
over lunch or overnight, offer `relay time -90 "lunch"`. The number that
eventually reaches the client should be one they'd stand behind.

## Finishing

When the user confirms it's done:

1. Check the work is actually complete — tests run, changes committed.
2. `relay done REL-7 "one line the client will read"`.

The note goes to the client verbatim, so write it for them, not the team:
"Fixed the timeout on CSV export" rather than "bumped proxy_read_timeout".
Internal detail belongs in `relay note`.

The client is told a rounded duration ("about 3 hours"). Never quote precise
figures to the client in anything you draft.

## Blocked

```bash
relay block REL-7 "waiting on API credentials from the client"
```

Stops the clock and tells the client why. The reason is client-visible, so
phrase it as something they can act on.

## Command reference

| Command | Effect |
|---|---|
| `relay tasks [open\|mine\|unclaimed\|all\|done]` | list the ledger |
| `relay show REL-7` | detail, conversation, sessions |
| `relay claim REL-7` | assign to yourself |
| `relay start [REL-7]` | start the clock, inferring the task if omitted |
| `relay stop` | pause; the task stays open |
| `relay done REL-7 [note]` | finish; the client hears the rounded time |
| `relay ask REL-7 <question>` | ask the client, in their thread |
| `relay reply REL-7 <message>` | update the client without a question |
| `relay note REL-7 <text>` | internal note |
| `relay block REL-7 <reason>` | mark blocked, stop the clock |
| `relay reopen REL-7 [reason]` | undo a premature done |
| `relay time -30 [why]` | correct the running session |
| `relay me` | who you are and what's running |

`--json` on any command gives structured output. Prefer the human output when
reporting back to the user.
