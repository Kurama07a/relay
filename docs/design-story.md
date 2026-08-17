# Relay website design story

_Generated: 2026-08-17_

## Project context

Relay connects client Slack conversations with engineering work. The website's
job is to make that two-sided workflow understandable in seconds, then give a
technical evaluator enough concrete detail to trust and install it.

The audience is a small engineering or agency team already serving clients in
Slack.

## Narrative

**Core message:** a request can move without losing its human context.

The visual metaphor is a physical signal route: two endpoints, one bright line,
and a small console that exposes the current state. The visitor first sees the
handoff happen, then learns the rules that make it safe, then reaches setup and
source.

## User journey

1. **Entry:** the thesis “Client asks. Engineering moves.” establishes the two
   actors and the product's job.
2. **Proof:** the interactive board lets the visitor claim, start, finish, and
   replay a realistic request.
3. **Understanding:** the three-step flow explains how channels and threads stay
   linked.
4. **Trust:** internal-by-default communication, exact-vs-rounded time, durable
   SQLite state, and safe retries show the product's judgment.
5. **Action:** setup begins in two throwaway channels and ends with the bot
   hosted as one persistent Coolify service.

## Peak moment

The handoff board is the single bold device. Each click moves the same request
through a real Relay state while changing both the client response and team
card. The site does not scatter unrelated animation around it.

## Design rationale

The safety-orange cable is drawn from industrial routing and dispatch systems.
Celery and marigold make acknowledgement and health feel warm without falling
into the common purple/blue SaaS palette. Paper surfaces keep the long technical
copy approachable; carbon sections provide operational gravity.

The site is multi-page because About, Features, and Setup serve different
reading modes. Navigation remains identical, while each page opens with one
large editorial thesis instead of a repeated marketing hero formula.

## Technical storytelling

Static files make the product site easy to publish anywhere. The setup copy
explicitly separates that static site from the always-on Relay bot, whose
Coolify deployment needs one replica and a persistent `/data` volume.
