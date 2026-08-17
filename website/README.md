# Relay product website

A dependency-free static site for Relay.

Production: <https://relay.prakhar.wtf>

## Pages

- `index.html` — product landing page and interactive handoff demo
- `about.html` — product story and design principles
- `features.html` — complete feature catalog
- `setup.html` — local Slack setup and Coolify bot deployment guide

## Preview locally

From the repository root:

```bash
npx serve website
```

Or open `website/index.html` directly. A local server is preferable because it
matches normal static hosting behavior.

## Hosting on Vercel

The website is plain HTML, CSS, and JavaScript. Deploy `website/` as its own
Vercel project:

```bash
cd website
npx vercel@latest --prod
```

`vercel.json` enables clean URLs, security headers, and long-lived caching for
the static assets. No build command or environment variables are required.

The website is **not** part of Relay's Coolify deployment. Coolify runs the
long-lived Slack bot from the root `Dockerfile`; use:

```bash
npm run coolify probe
npm run coolify create
npm run coolify env
npm run coolify deploy
npm run coolify status
```

See [DEPLOY.md](../DEPLOY.md) for the required persistent `/data` volume and
single-instance constraint.

## Validate

```bash
npm run site:check
```

This checks the four pages, shared assets, page titles, GitHub link, active
navigation, and relative links.
