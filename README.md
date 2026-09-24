# WikimediaPatched

Apply unmerged Gerrit patches to live Wikimedia wikis, in the browser.

Like [WikimediaDebug], but instead of routing you to a debug host that somebody
already deployed to, it injects the client-side parts of a Gerrit change into
the page you are looking at.

The point is to test a patch against **real content with your real account** —
the one thing [patchdemo] cannot give you.

## What it can and cannot do

It can apply:

- JavaScript files in a ResourceLoader module
- English messages from `i18n/en.json`
- Stylesheets, once the LESS compiler lands

It can never apply PHP, hooks, schema changes, API changes or new module
registrations. Those need a real deploy. Use [patchdemo] for those. The popup
lists every file in the change and says what happened to each one.

## Security

This runs code from an unmerged change inside a wiki page with your session.
That code can do anything you can do.

- The switch lives in session storage, so it turns itself off with the browser.
- A patch does nothing until you tick "I read this code".
- Development wikis work out of the box. A production wiki needs an explicit
  permission grant in the options page.
- The extension refuses to patch login and credential pages.
- If your account has `sysop`, `interface-admin` or `checkuser`, it warns.

Both the Chrome Web Store and AMO forbid remote code execution, which is what
this is. So Chrome means an unpacked install, and Firefox means a signed
unlisted XPI.

## Build and install

```sh
npm run build          # writes dist/chrome and dist/firefox
npm test               # unit tests, no network
npm run smoke          # reads a real change from gerrit.wikimedia.org
```

- **Chrome**: `chrome://extensions` -> Developer mode -> Load unpacked ->
  `dist/chrome`.
- **Firefox**: `about:debugging#/runtime/this-firefox` -> Load Temporary
  Add-on -> `dist/firefox/manifest.json`.

## How it works

ResourceLoader delivers a module as `mw.loader.impl(declarator)`, where
`declarator` returns `[key, script, styles, messages, templates]`. For a
`packageFiles` module the script is `{main, files: {"path.js": function(…){…}}}`.

A `world: "MAIN"` content script runs at `document_start`, before the startup
module. It hooks `window.mw`, then `mw.loader`, then wraps `mw.loader.impl`.
The wrapper calls the declarator, swaps whole files in the returned data, and
re-wraps it. Nothing in ResourceLoader checks module content, so this works.

Whole files come from Gerrit, not diff hunks. Reading the **parent** revision
of the same file gives a free check: if it matches the live payload exactly,
the replacement is certainly right. If it does not, the wiki runs a different
base and the popup says so.

## Status

- [x] Phase 1 — Gerrit client, patch model, storage, popup
- [ ] Phase 2 — messages, styles, new-file injection
- [ ] Phase 3 — `mw.loader.impl` wrapper, module resolver, skew reporting
- [ ] Phase 4 — per-tab debug mode, Firefox parity, distribution

[WikimediaDebug]: https://gerrit.wikimedia.org/g/performance/WikimediaDebug
[patchdemo]: https://patchdemo.wmcloud.org/
