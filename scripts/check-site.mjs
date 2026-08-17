#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "website");
const pages = ["index.html", "about.html", "features.html", "setup.html"];
const errors = [];

for (const asset of ["styles.css", "app.js", "favicon.svg"]) {
  if (!existsSync(join(site, asset))) errors.push(`missing shared asset: ${asset}`);
}

for (const page of pages) {
  const path = join(site, page);
  if (!existsSync(path)) {
    errors.push(`missing page: ${page}`);
    continue;
  }

  const html = readFileSync(path, "utf8");
  if (!/<html\s+lang="en"/i.test(html)) errors.push(`${page}: missing document language`);
  if (!/<title>[^<]+<\/title>/i.test(html)) errors.push(`${page}: missing title`);
  if (!/<meta\s+name="description"/i.test(html)) errors.push(`${page}: missing description`);
  if (!/<main\s+id="main"/i.test(html)) errors.push(`${page}: missing main landmark`);
  if ((html.match(/aria-current="page"/g) ?? []).length !== 1) {
    errors.push(`${page}: expected exactly one active navigation item`);
  }
  if (!html.includes("https://github.com/Kurama07a/relay")) {
    errors.push(`${page}: missing repository link`);
  }

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (
      target.startsWith("#") ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("data:")
    ) {
      continue;
    }

    const clean = target.split("#", 1)[0].split("?", 1)[0];
    if (clean && !existsSync(join(site, clean))) {
      errors.push(`${page}: broken relative link ${target}`);
    }
  }
}

const css = readFileSync(join(site, "styles.css"), "utf8");
for (const token of ["--carbon:", "--paper:", "--orange:", "--marigold:", "--celery:"]) {
  if (!css.includes(token)) errors.push(`styles.css: missing design token ${token}`);
}
if (!css.includes("prefers-reduced-motion")) {
  errors.push("styles.css: missing reduced-motion handling");
}

try {
  const vercel = JSON.parse(readFileSync(join(site, "vercel.json"), "utf8"));
  if (vercel.cleanUrls !== true) errors.push("vercel.json: clean URLs are not enabled");
  const headers = JSON.stringify(vercel.headers ?? []);
  if (!headers.includes("Content-Security-Policy")) errors.push("vercel.json: CSP header is missing");
  if (!headers.includes("Strict-Transport-Security")) errors.push("vercel.json: HSTS header is missing");
  if (headers.includes("immutable")) errors.push("vercel.json: unversioned assets must not use immutable caching");
} catch (error) {
  errors.push(`vercel.json: ${error.message}`);
}

if (errors.length > 0) {
  console.error("Site checks failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Site checks passed: ${pages.length} pages and shared assets are linked correctly.`);
