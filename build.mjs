#!/usr/bin/env node
/**
 * Build one unpacked extension for each browser.
 *
 * Chrome and Firefox need different manifests: a service worker against an
 * event page, declarativeNetRequest against webRequest. The rest of the code
 * is the same, so it is copied.
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEV_WIKI_MATCHES, PROD_WIKI_MATCHES, NON_WIKI_MATCHES, GERRIT_ORIGIN
} from './shared/constants.js';

const ROOT = dirname( fileURLToPath( import.meta.url ) );
const DIST = join( ROOT, 'dist' );
const VERSION = '0.1.0';

const SOURCE_DIRS = [ 'background', 'content', 'shared', 'popup', 'options', 'icons' ];

const WIKI_MATCHES = [ ...DEV_WIKI_MATCHES, ...PROD_WIKI_MATCHES ];

function baseManifest() {
	return {
		manifest_version: 3,
		name: 'WikimediaPatched',
		version: VERSION,
		description:
			'Apply unmerged Gerrit patches to live Wikimedia wikis. Client-side code only.',
		permissions: [ 'storage', 'cookies', 'scripting', 'tabs' ],
		host_permissions: [ GERRIT_ORIGIN + '/*', ...DEV_WIKI_MATCHES ],
		optional_host_permissions: PROD_WIKI_MATCHES,
		icons: {
			16: 'icons/icon-16.png',
			32: 'icons/icon-32.png',
			48: 'icons/icon-48.png',
			128: 'icons/icon-128.png'
		},
		action: {
			default_popup: 'popup/popup.html',
			default_title: 'WikimediaPatched',
			default_icon: {
				16: 'icons/icon-16.png',
				32: 'icons/icon-32.png'
			}
		},
		options_ui: { page: 'options/options.html', open_in_tab: true },
		content_scripts: [
			{
				matches: WIKI_MATCHES,
				exclude_matches: NON_WIKI_MATCHES,
				js: [ 'content/main-world.js' ],
				run_at: 'document_start',
				world: 'MAIN',
				all_frames: false
			},
			{
				matches: WIKI_MATCHES,
				exclude_matches: NON_WIKI_MATCHES,
				js: [ 'content/bridge.js' ],
				run_at: 'document_start',
				all_frames: false
			}
		],
		web_accessible_resources: [
			{ resources: [ 'content/main-world.js' ], matches: WIKI_MATCHES }
		]
	};
}

function chromeManifest() {
	const m = baseManifest();
	m.background = { service_worker: 'background/sw.js', type: 'module' };
	// Phase 4 rewrites the startup module URL instead of setting a cookie.
	m.permissions.push( 'declarativeNetRequest' );
	return m;
}

function firefoxManifest() {
	const m = baseManifest();
	// Firefox keeps event pages, which survive better than a service worker.
	m.background = { scripts: [ 'background/sw.js' ], type: 'module' };
	m.permissions.push( 'webRequest', 'webRequestBlocking' );
	m.browser_specific_settings = {
		gecko: { id: 'wikimedia-patched@wikimedia.org', strict_min_version: '128.0' }
	};
	return m;
}

async function buildOne( name, manifest ) {
	const out = join( DIST, name );
	await rm( out, { recursive: true, force: true } );
	await mkdir( out, { recursive: true } );
	for ( const dir of SOURCE_DIRS ) {
		await cp( join( ROOT, dir ), join( out, dir ), { recursive: true } ).catch( () => {} );
	}
	await writeFile(
		join( out, 'manifest.json' ), JSON.stringify( manifest, null, '\t' ) + '\n'
	);
	console.log( `built dist/${ name }` );
}

await buildOne( 'chrome', chromeManifest() );
await buildOne( 'firefox', firefoxManifest() );
