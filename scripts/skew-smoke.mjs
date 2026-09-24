#!/usr/bin/env node
/**
 * Run a patch against the module a live wiki is serving right now.
 *
 * Fetches the module in debug mode, so its source is verbatim, and feeds it
 * through the built content script in the test harness. The module never
 * executes (that needs VisualEditor); the rewrite happens before that, so
 * the per-file verdicts are real.
 *
 * Run with: node scripts/skew-smoke.mjs [change] [wiki] [module]
 */
import { createPage, bootMediaWiki } from '../test/harness.js';
import { parsePatchRef } from '../background/gerrit.js';
import { preparePatch } from '../background/prepare.js';
import { withDeployed } from '../background/deployed.js';

const change = process.argv[ 2 ] || '1321624/17';
const wiki = process.argv[ 3 ] || 'https://en.wikipedia.org';
const module = process.argv[ 4 ] || 'ext.visualEditor.editCheck';

const siteinfo = await ( await fetch(
	`${ wiki }/w/api.php?action=query&meta=siteinfo&format=json`,
	{ headers: { 'User-Agent': 'wikimedia-patched skew smoke test' } }
) ).json();
const version = siteinfo.query.general.generator.replace( /^MediaWiki /, '' );

// The request the loader itself makes: no only=scripts. An only=scripts
// response ends by setting the module to "ready", which the loader's own
// responses never do.
const loadUrl = `${ wiki }/w/load.php?lang=en&modules=${ module }&skin=vector-2022&debug=2`;
const moduleText = await ( await fetch( loadUrl ) ).text();

const prepared = await preparePatch( parsePatchRef( change ) );

async function run( label, patch, debug, { late = false } = {} ) {
	const page = createPage();
	page.runFile( 'dist/chrome/content/main-world.js' );
	const channel = page.document.documentElement.dataset.wmpChannel;
	const reports = [];
	page.document.addEventListener( channel + ':out', ( ev ) => reports.push( ev.detail ) );
	const payload = {
		active: true, reason: null, siteKind: 'prod', elevatedAck: true, patches: [ patch ]
	};
	const answer = () => page.runScript(
		`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) },` +
		` { detail: ${ JSON.stringify( payload ) } } ) );` );
	if ( !late ) {
		answer();
	}
	bootMediaWiki( page, { debug } );
	// As work() does, mark the module as requested before its response runs.
	page.runScript( `mw.loader._request( ${ JSON.stringify( module ) } );` );
	page.runScript( moduleText, loadUrl );
	if ( late ) {
		const state = page.window.mw.loader.moduleRegistry[ module ].state;
		console.log( `\n(module arrived first; its state while waiting: ${ state })` );
		await page.flush( 300 );
		answer();
	}
	await page.flush( 150 );

	console.log( `\n== ${ label } ==` );
	for ( const row of ( reports.at( -1 ) || { files: [] } ).files ) {
		console.log( `  [${ row.status }] ${ row.path.split( '/' ).pop() }\n      ${ row.reason }` );
	}
}

console.log( `${ wiki } runs ${ version }; ${ module } is ${ moduleText.length }B in debug mode` );
await run( 'debug mode: merge against the running page', prepared, true );
await run( 'no debug mode: merge against the deployed branch',
	await withDeployed( prepared, version ), false );
await run( 'module arrives 300ms before the patch data', prepared, true, { late: true } );
