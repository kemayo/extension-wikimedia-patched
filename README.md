# WikimediaPatched

Apply unmerged Gerrit patches to live Wikimedia wikis, in the browser.

Like [WikimediaDebug], but instead of routing you to a debug host that somebody
already deployed to, it injects the client-side parts of a Gerrit change into
the page you are looking at.

The point is to test a patch against **real content with your real account** —
the one thing [patchdemo] cannot give you.

## What it can and cannot do

It can apply:

- New JavaScript files added to a ResourceLoader module
- English messages from `i18n/en.json`
- Stylesheets, including their `@import` chain across repositories
- Changes to existing JavaScript files, with a warning when the wiki runs a
  different base than the patch was written against

It can never apply PHP, hooks, schema changes, API changes or new module
registrations. Those need a real deploy. Use [patchdemo] for those. The popup
lists every file in the change and says what happened to each one.

## Where things live

A patch names a file by its path in one repository. That is not enough to do
anything with it, so the extension knows the shape of a MediaWiki install
(`shared/mw-layout.js`):

- A Gerrit project maps to where a wiki puts it: `mediawiki/extensions/Foo`
  becomes `extensions/Foo`, `mediawiki/skins/Vector` becomes `skins/Vector`.
- `wgVersion` maps to the branch the wiki runs. A wiki reporting
  `1.47.0-wmf.20` is running `wmf/1.47.0-wmf.20`, so every lookup reads the
  code that wiki really has, not master.
- A skin key maps to the repository that provides it. `vector-2022` and
  `vector` both come from `mediawiki/skins/Vector`, `minerva` from
  `MinervaNeue`, `contenttranslation` from an extension, and a few come from
  core.

That is enough to follow a stylesheet's imports. `@import
'mediawiki.skin.variables.less'` has no fixed answer: ResourceLoader looks in
the active skin's `SkinLessImportPaths` directory first, then in core's
`resources/src/mediawiki.less`. So the extension reads the skin's own
manifest for that directory rather than copying the value, and falls back to
core the way ResourceLoader does. Names beginning
`mediawiki.skin.codex/`, `mediawiki.skin.codex-design-tokens/` or
`@wikimedia/codex-icons/` are not paths at all; they map into core's
`resources/lib/`.

For change 1321624 on Vector 2022 at `wmf/1.47.0-wmf.20`, that resolves to
eight files across two repositories:

```
mediawiki/skins/Vector  resources/mediawiki.less/vector-2022/mediawiki.skin.variables.less
mediawiki/core          resources/src/mediawiki.less/mediawiki.skin.defaults.less
mediawiki/core          resources/lib/codex/mixins/codex-public-mixins.less
mediawiki/core          resources/lib/codex/mixins/css-icon.less
mediawiki/core          resources/lib/codex-icons/codex-icon-paths.less
mediawiki/core          resources/lib/codex/mixins/link.less
mediawiki/core          resources/lib/codex/mixins/button-layout-flush.less
mediawiki/core          resources/lib/codex-design-tokens/theme-wikimedia-ui.less
```

Run `node scripts/less-smoke.mjs` to see it happen against the real Gerrit.

Because the answer depends on the skin, and only the page knows the skin,
the page asks the background worker to build its stylesheets once
`mw.config` is filled. The result is cached per patch, skin and wiki version.

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
npm install less       # optional, but LESS stays uncompiled without it
npm run build          # writes dist/chrome and dist/firefox
npm test               # unit tests, no network
npm run smoke          # reads a real change from gerrit.wikimedia.org
npm run smoke:less     # resolves that change's stylesheet imports
npm run smoke:skew     # merges that change onto enwiki's live module
```

The build vendors `node_modules/less/lib/less` into `vendor/` when it is
there. Not `dist/less.min.js`: that build is for a browser page and reads
`document.currentScript` as it loads, so it throws in a background worker.
`lib/less` is the environment-agnostic core and needs no DOM. Its two bare
imports are rewritten to copies placed beside it.

The extension never fetches a compiler at run time: code has to ship in the
package. Without one, stylesheets are reported as skipped and everything
else still works.

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

### When a module arrives before the patch data

The patch data comes from the background worker, which may be asleep or
still reading Gerrit when the page's first modules arrive. A module that
runs before the data is in cannot be patched afterwards: running it again
would repeat every side effect.

So the wrapper holds a module's payload until the data arrives, then
releases them in arrival order. Holding is only safe for the answer to a
request the loader made itself. `work()` marks each module it fetches as
`loading` before it sends the request, and that request has no completion
callback, so a held payload looks the same as a slow network. Nothing else
may wait:

- An `impl` inline in the page HTML, such as `user.options`, is followed at
  once by code that expects it. It is `registered`, never `loading`.
- An `only=scripts` response sets its module to `ready` straight after the
  `impl`.
- The base modules hold up everything, this script included.

If the data has not arrived after two seconds, the modules are released
unpatched and the popup says so. The report and the console say how many
modules waited and for how long.

## When the wiki runs a different base

A patch is written against master. A wiki runs a wmf branch cut some days
earlier. So the file the patch changes is usually not the file the wiki has,
and replacing it whole would also bring in every unrelated master change
since the cut — and undo any backport the branch got.

So the extension does a three-way merge (`shared/merge3.js`): it takes only
the patch's own changes, base to patched, and puts them onto the wiki's copy.
The wiki's copy comes from the best source there is:

1. **The running page**, in debug mode. The payload holds each file
   verbatim, so this is exactly what the wiki runs. No network needed.
2. **The wmf branch**, otherwise. The page reports `wgVersion`, and the
   worker fetches that branch's copy in the background, so the next load has
   it. Master is never used as a stand-in: it is not what the wiki runs.

Then, per file:

| The wiki's copy is… | The extension… | Status |
|---|---|---|
| the patched file | leaves it alone — the patch is already live | applied |
| the patch base | replaces it | applied |
| something else, and the merge is clean | runs the merge | merged |
| something else, and the merge conflicts | replaces it, and says how many wiki lines that drops | base-skew |
| unknown | replaces it, and says the base was not checked | applied |

The merge is conservative: edits on the same or adjacent lines count as a
conflict, as in diff3. A false conflict costs a warning; a false clean merge
would cost broken code in silence. A clean merge that does not parse as
JavaScript is not run either.

For change 1321624 on enwiki today, all three changed files merge cleanly.
`EditCheckActionWidget.js` shows why it matters: replacing it whole would
have removed 13 lines enwiki runs and added 20 unrelated lines from master,
on top of the patch. `npm run smoke:skew` runs the patch against the module
enwiki is serving right now.

## What is verified, and what is not

Verified:

- The wire format. `test/fixtures/editcheck-checks.debug.js` is a trimmed
  copy of a live `en.wikipedia.org` `load.php?debug=2` response. The tests
  assert the shape the extension depends on: verbatim source, an empty
  version hash, and one real function per packaged file.
- The page behaviour. `test/harness.js` is a small ResourceLoader stand-in
  that copies the order core creates things in — `window.mw`, then
  `mw.loader`, then `mw.loader.store`. `test/main-world.test.js` runs the
  built content script against it and checks replacement, added files, base
  skew, the store being off, the credential-page refusal, the elevated-rights
  gate, and that a throwing declarator does not break the page.
- The Gerrit pipeline. `npm run smoke` reads change 1321624 from the real
  Gerrit and prints what the extension would do with each of its files.
- Import resolution and compiling. `npm run smoke:less` resolves that
  change's stylesheet against the live repositories at the branch enwiki
  runs, finds all eight files, and compiles the 170KB result down to the
  patch's own rules. Codex tokens come out as
  `var( --border-color-muted, #dadde3 )`, so one compiled blob stays correct
  in light and dark mode. The offline tests cover the rules themselves,
  including that an `@import` inside a comment is left alone — MediaWiki's
  own files show examples that way.

Not verified, because it needs a real browser:

- Loading the extension at all, in either browser.
- Whether the `resourceLoaderDebug` cookie survives the Wikimedia CDN for a
  logged-out reader. Test on the Beta Cluster, signed in and signed out.
- The per-tab request rewrite. It is written and can be turned on in the
  options, but it is **off by default** until somebody checks it. The
  ordering is the risk: the rule must land before the startup script is
  requested.
- Whether `world: "MAIN"` content scripts really run before the startup
  module in Firefox. If they do not, the fallback is the
  `<script src=moz-extension://…>` injection, which is not written yet.
- The production permission prompt.
- Whether a background service worker imports the vendored compiler the same
  way Node does. Node has no `document` either, which is why the vendored
  build is the DOM-free one, but a worker is not a perfect stand-in.

## Status

- [x] Phase 1 — Gerrit client, patch model, storage, popup
- [x] Phase 2 — messages, styles, new-file injection
- [x] Phase 3 — `mw.loader.impl` wrapper, module resolver, skew reporting
- [~] Phase 4 — per-tab debug mode and the browser namespace shim are
  written; browser checks, the Firefox injection fallback and distribution
  are not done

[WikimediaDebug]: https://gerrit.wikimedia.org/g/performance/WikimediaDebug
[patchdemo]: https://patchdemo.wmcloud.org/
