#!/usr/bin/env node
/**
 * Build one unpacked extension for each browser.
 *
 * Chrome and Firefox need different manifests: a service worker against an
 * event page, declarativeNetRequest against webRequest. The rest of the code
 * is the same, so it is copied.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEV_WIKI_MATCHES, PROD_WIKI_MATCHES, NON_WIKI_MATCHES, GERRIT_ORIGIN
} from './shared/constants.js';

const ROOT = dirname( fileURLToPath( import.meta.url ) );
const DIST = join( ROOT, 'dist' );
const VERSION = '0.1.0';
const BUILD_ID = new Date().toISOString();

const SOURCE_DIRS = [ 'background', 'content', 'shared', 'popup', 'options', 'icons', 'vendor' ];

const WIKI_MATCHES = [ ...DEV_WIKI_MATCHES, ...PROD_WIKI_MATCHES ];

function baseManifest() {
	return {
		manifest_version: 3,
		name: 'WikimediaPatched',
		version: VERSION,
		description:
			'Apply unmerged Gerrit patches to live Wikimedia wikis. Client-side code only.',
		permissions: [ 'storage', 'cookies', 'scripting', 'tabs', 'webNavigation' ],
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
			// The switch starts off in every browser session, so the
			// toolbar starts grey. The worker sets the icon from then on.
			default_icon: {
				16: 'icons/icon-off-16.png',
				32: 'icons/icon-off-32.png'
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

/**
 * Inline the files a content script asks for.
 *
 * A content script cannot be an ES module, but the pure helpers must stay
 * importable so the unit tests can reach them. So the build pastes them in
 * and drops the `export` keyword.
 *
 * @param {string} source
 * @return {Promise<string>}
 */
async function inlineIncludes( source ) {
	const lines = source.split( '\n' );
	const out = [];
	for ( const line of lines ) {
		const m = /^(\s*)\/\/ @include (\S+)$/.exec( line );
		if ( !m ) {
			out.push( line );
			continue;
		}
		const text = await readFile( join( ROOT, m[ 2 ] ), 'utf8' );
		out.push( `${ m[ 1 ] }// --- inlined from ${ m[ 2 ] } ---` );
		out.push( text.replace( /^export (const|function|class|let|var) /gm, '$1 ' ) );
		out.push( `${ m[ 1 ] }// --- end ${ m[ 2 ] } ---` );
	}
	return out.join( '\n' );
}

/**
 * Put the LESS compiler into vendor/, from node_modules.
 *
 * Not the dist/ build: that one is for a browser page and reads
 * document.currentScript as it loads, so it throws in a background worker.
 * lib/less is the environment-agnostic core, a factory that needs no DOM.
 *
 * It has two bare imports, which a browser cannot resolve, so they are
 * rewritten to files copied in beside it.
 *
 * Without node_modules/less a stub is written, and the extension says so
 * instead of failing quietly.
 */
const LESS_BARE_IMPORTS = {
	'copy-anything': '../deps/copy-anything.js',
	'parse-node-version': '../deps/parse-node-version.js'
};

/** Copy a tree of ES modules, rewriting the imports a browser cannot resolve. */
async function copyModuleTree( from, to, rewrite ) {
	await mkdir( to, { recursive: true } );
	for ( const entry of await readdir( from, { withFileTypes: true } ) ) {
		const src = join( from, entry.name );
		const dest = join( to, entry.name );
		if ( entry.isDirectory() ) {
			await copyModuleTree( src, dest, rewrite );
		} else if ( entry.name.endsWith( '.js' ) ) {
			let text = await readFile( src, 'utf8' );
			for ( const [ bare, target ] of Object.entries( rewrite ) ) {
				text = text.replaceAll( `from '${ bare }'`, `from '${ target }'` );
			}
			await writeFile( dest, text );
		}
	}
}

async function vendorLess() {
	const lib = join( ROOT, 'node_modules/less/lib/less' );
	// vendor/ is generated, so a fresh clone does not have it.
	await mkdir( join( ROOT, 'vendor' ), { recursive: true } );
	try {
		await readFile( join( lib, 'index.js' ), 'utf8' );
	} catch ( e ) {
		await writeFile( join( ROOT, 'vendor', 'less.js' ),
			'// No LESS compiler. Run `npm install less` and build again.\n' +
			'export default null;\n' );
		console.log( 'no node_modules/less; stylesheets that need a compiler will be skipped' );
		return false;
	}

	await rm( join( ROOT, 'vendor/less' ), { recursive: true, force: true } );
	await rm( join( ROOT, 'vendor/deps' ), { recursive: true, force: true } );
	await copyModuleTree( lib, join( ROOT, 'vendor/less' ), LESS_BARE_IMPORTS );

	// copy-anything, and the is-what it imports.
	await mkdir( join( ROOT, 'vendor/deps' ), { recursive: true } );
	for ( const [ pkg, file ] of [
		[ 'copy-anything', 'copy-anything.js' ], [ 'is-what', 'is-what.js' ]
	] ) {
		const text = await readFile( join( ROOT, `node_modules/${ pkg }/dist/index.js` ), 'utf8' );
		await writeFile( join( ROOT, 'vendor/deps', file ),
			text.replaceAll( "from 'is-what'", "from './is-what.js'" ) );
	}

	// parse-node-version is CommonJS and is only asked for less.version, so
	// a small module stands in for it.
	await writeFile( join( ROOT, 'vendor/deps/parse-node-version.js' ),
		[
			'// Stands in for parse-node-version, which is CommonJS.',
			'// less only reads major, minor and patch, for less.version.',
			'export default function parseVersion( version ) {',
			"\tconst m = /^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([^+]+))?(?:\\+(.+))?$/",
			'\t\t.exec( String( version ) );',
			'\tif ( !m ) {',
			"\t\tthrow new Error( `Unable to parse: ${ version }` );",
			'\t}',
			'\treturn {',
			'\t\tmajor: Number( m[ 1 ] ), minor: Number( m[ 2 ] ), patch: Number( m[ 3 ] ),',
			"\t\tpre: m[ 4 ] || null, build: m[ 5 ] ? m[ 5 ].split( '.' ) : []",
			'\t};',
			'}',
			''
		].join( '\n' ) );

	const version = JSON.parse(
		await readFile( join( ROOT, 'node_modules/less/package.json' ), 'utf8' )
	).version;

	await writeFile( join( ROOT, 'vendor/less.js' ), [
		'// Generated by build.mjs from node_modules/less/lib/less. Do not edit.',
		"import lessFactory from './less/index.js';",
		'',
		'const less = lessFactory( {}, [] );',
		'',
		'// The core leaves this to whichever build wraps it. The extension',
		'// never loads a LESS plugin, so refusing is the whole contract.',
		'class NoPluginLoader extends less.AbstractPluginLoader {',
		'\tconstructor( lessInstance ) {',
		'\t\tsuper();',
		'\t\tthis.less = lessInstance;',
		'\t}',
		'',
		'\tloadPlugin( filename ) {',
		"\t\treturn Promise.reject( new Error( 'LESS plugins are not supported: ' + filename ) );",
		'\t}',
		'}',
		'less.PluginLoader = NoPluginLoader;',
		`less.version = ${ JSON.stringify( version ) };`,
		'',
		'export default less;',
		''
	].join( '\n' ) );

	console.log( `vendored less ${ version } (lib/less, no DOM needed)` );
	return true;
}

async function buildOne( name, manifest ) {
	const out = join( DIST, name );
	await rm( out, { recursive: true, force: true } );
	await mkdir( out, { recursive: true } );
	for ( const dir of SOURCE_DIRS ) {
		await cp( join( ROOT, dir ), join( out, dir ), { recursive: true } ).catch( () => {} );
	}
	// Stamp the build, so the popup can tell when the worker is older.
	const constants = join( out, 'shared/constants.js' );
	await writeFile( constants, ( await readFile( constants, 'utf8' ) )
		.replace( "export const BUILD_ID = 'dev';", `export const BUILD_ID = '${ BUILD_ID }';` ) );

	// Content scripts cannot import, so their includes are pasted in.
	for ( const file of [ 'content/main-world.js', 'content/bridge.js' ] ) {
		const src = await readFile( join( ROOT, file ), 'utf8' );
		await writeFile( join( out, file ), await inlineIncludes( src ) );
	}
	await writeFile(
		join( out, 'manifest.json' ), JSON.stringify( manifest, null, '\t' ) + '\n'
	);
	console.log( `built dist/${ name }` );
}

await vendorLess();
await buildOne( 'chrome', chromeManifest() );
await buildOne( 'firefox', firefoxManifest() );
