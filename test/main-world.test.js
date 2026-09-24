import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage, bootMediaWiki } from './harness.js';

const MAIN_WORLD = 'dist/chrome/content/main-world.js';
const REAL_FIXTURE = 'test/fixtures/editcheck-checks.debug.js';

/**
 * Start a page with main-world.js already installed, then hand it a
 * patch payload the way the bridge would.
 *
 * @param {Object|null} payload
 * @return {Promise<Object>} The page, plus a reports array.
 */
async function startPage( payload, onRequest ) {
	const page = createPage();
	page.runFile( MAIN_WORLD );

	const channel = page.document.documentElement.dataset.wmpChannel;
	assert.ok( channel, 'main-world.js must publish a channel' );

	const reports = [];
	page.document.addEventListener( channel + ':out', ( ev ) => reports.push( ev.detail ) );

	// Stand in for the bridge, which relays a question to the worker.
	const requests = [];
	page.document.addEventListener( channel + ':req', ( ev ) => {
		requests.push( ev.detail.message );
		Promise.resolve( onRequest ? onRequest( ev.detail.message ) : null )
			.then( ( result ) => page.runScript(
				`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':res' ) }, ` +
				`{ detail: ${ JSON.stringify( { id: ev.detail.id, ok: true } ) } } ) );`
					.replace( '"ok":true', '"ok":true,"result":' + JSON.stringify( result || {} ) )
			) );
	} );
	page.requests = requests;

	if ( payload ) {
		page.runScript(
			`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) }, ` +
			`{ detail: ${ JSON.stringify( payload ) } } ) );`
		);
	}
	await page.flush();
	return { page, reports, channel, requests };
}

function patchWith( overrides ) {
	return {
		active: true,
		reason: null,
		siteKind: 'dev',
		elevatedAck: false,
		patches: [ Object.assign( {
			key: '1321624@17',
			changeNumber: '1321624',
			patchset: 17,
			project: 'mediawiki/extensions/VisualEditor',
			messages: {},
			styles: [],
			replaceFiles: [],
			newFiles: [],
			skipped: [],
			notes: []
		}, overrides ) ]
	};
}

// ---------------------------------------------------------------- assumptions

test( 'the real production payload has the shape the extension expects', () => {
	const page = createPage();
	bootMediaWiki( page );
	page.runFile( REAL_FIXTURE );

	const entry = page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.editCheck.checks' ];
	assert.ok( entry, 'the module registered itself' );
	// Debug mode leaves the version empty.
	assert.equal( entry.version, '' );
	// A packageFiles module carries main plus a files map.
	assert.equal( entry.script.main, 'init.js' );
	// Keys are bare names, because this module sets its own base path.
	assert.ok( entry.script.files[ 'AddReferenceEditCheck.js' ] );
	assert.equal( typeof entry.script.files[ 'AddReferenceEditCheck.js' ], 'function' );
	// The main file is generated, and only requires the other files.
	assert.match( String( entry.script.files[ 'init.js' ] ), /require\( ?'\.\/\w+\.js' ?\)/ );
} );

// ---------------------------------------------------------------------- hooks

test( 'the module store is off before it can read localStorage', async () => {
	const { page } = await startPage( patchWith( {} ) );
	bootMediaWiki( page );
	const store = page.window.mw.loader.store;
	assert.equal( store.enabled, false );
	store.init();
	assert.equal( store.enabled, false, 'init() must not switch it back on' );
} );

test( 'hooking leaves mw and mw.loader as plain properties', async () => {
	const { page } = await startPage( patchWith( {} ) );
	bootMediaWiki( page );
	const mwDesc = Object.getOwnPropertyDescriptor( page.window, 'mw' );
	assert.equal( typeof mwDesc.get, 'undefined', 'window.mw must not stay an accessor' );
	const loaderDesc = Object.getOwnPropertyDescriptor( page.window.mw, 'loader' );
	assert.equal( typeof loaderDesc.get, 'undefined', 'mw.loader must not stay an accessor' );
	assert.equal( page.window.mw, page.window.mediaWiki );
} );

test( 'a module sees the patched messages when it runs', async () => {
	// The new edit check calls ve.msg() as it loads, so its messages must be
	// in place before its module runs, not merely before the page ends.
	const { page } = await startPage( patchWith( {
		messages: { 'editcheck-sourceveri-title': 'Check the source' }
	} ) );
	bootMediaWiki( page );
	page.runScript( 'mw.seen = null;' );
	page.runScript( modulePayload( 'ext.visualEditor.editCheck', 'init.js', {
		'init.js': "mw.seen = mw.messages.get( 'editcheck-sourceveri-title' );"
	} ) );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	assert.equal( page.window.mw.seen, 'Check the source' );
} );

// ------------------------------------------------------------------ injection

/** A module shaped like ext.visualEditor.editCheck.checks. */
const CHECKS_PAYLOAD = `
	mw.loader.impl( function () {
		return [ 'ext.visualEditor.editCheck.checks@', {
			main: 'init.js',
			files: {
				'AddReferenceEditCheck.js': function ( require, module, exports ) {
					mw.editcheck.registered.push( 'AddReference' );
				},
				'init.js': function ( require, module, exports ) {
					require( './AddReferenceEditCheck.js' );
				}
			}
		} ];
	} );
`;

async function runChecksModule( payload ) {
	const { page, reports } = await startPage( payload );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { registered: [] };' );
	page.runScript( CHECKS_PAYLOAD );
	await page.flush( 10 );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 100 );
	return { page, reports };
}

test( 'an added file runs inside the module its siblings live in', async () => {
	const { page, reports } = await runChecksModule( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/SourceVerificationEditCheck.js',
			kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js', 'init.js' ],
			source: "mw.editcheck.registered.push( 'SourceVerification' );\n" +
				'module.exports = { name: "SourceVerification" };'
		} ]
	} ) );

	const registered = page.runScript( 'mw.editcheck.registered' );
	assert.deepEqual( [ ...registered ], [ 'AddReference', 'SourceVerification' ],
		'the new check registers itself, after the module ran' );

	const entry = page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.editCheck.checks' ];
	assert.equal( entry.script.files[ 'SourceVerificationEditCheck.js' ] !== undefined, true,
		'other files in the module can now require it' );
	assert.equal(
		JSON.stringify( entry.packageExports[ 'SourceVerificationEditCheck.js' ] ),
		JSON.stringify( { name: 'SourceVerification' } )
	);

	const rows = reports.at( -1 ).files;
	const row = rows.find( ( f ) => f.path.endsWith( 'SourceVerificationEditCheck.js' ) );
	assert.equal( row.status, 'applied-new' );
	assert.match( row.reason, /ext\.visualEditor\.editCheck\.checks/ );
} );

test( 'an added file can require its neighbours', async () => {
	const { page } = await runChecksModule( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/Needy.js',
			kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js' ],
			source: "require( './AddReferenceEditCheck.js' );\n" +
				"mw.editcheck.registered.push( 'Needy' );"
		} ]
	} ) );
	const registered = page.runScript( 'mw.editcheck.registered' );
	// AddReference ran once, from init.js; require() must return the cache.
	assert.deepEqual( [ ...registered ], [ 'AddReference', 'Needy' ] );
} );

test( 'an added file with no owning module is reported, not dropped', async () => {
	const { page, reports } = await runChecksModule( patchWith( {
		newFiles: [ {
			path: 'somewhere/unrelated/Thing.js', kind: 'js', siblings: [],
			source: 'mw.editcheck.registered.push( "nope" );'
		} ]
	} ) );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ], [ 'AddReference' ],
		'a file with no home must not run anywhere' );

	// The leftover report waits for the page to settle.
	page.runScript( 'window.dispatchEvent( { type: "load" } );' );
	await page.flush( 1700 );

	const row = reports.flatMap( ( r ) => r.files )
		.find( ( f ) => f.path === 'somewhere/unrelated/Thing.js' );
	assert.equal( row.status, 'not-on-page' );
	assert.match( row.reason, /No module on this page owns this directory/ );
} );

// --------------------------------------------------------------------- safety

test( 'the impl wrapper never breaks a module it does not touch', async () => {
	const { page } = await startPage( patchWith( {} ) );
	bootMediaWiki( page );
	page.runScript( CHECKS_PAYLOAD.replace( 'mw.editcheck.registered.push', 'void 0 || (' )
		.replace( "( 'AddReference' );", "0 );" ) );
	const entry = page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.editCheck.checks' ];
	assert.equal( entry.state, 'loaded' );
} );

test( 'a declarator that throws falls through to the original impl', async () => {
	const { page } = await startPage( patchWith( {} ) );
	bootMediaWiki( page );
	assert.throws( () => page.runScript(
		'mw.loader.impl( function () { throw new Error( "boom" ); } );'
	), /boom/ );
	// The page is still usable.
	page.runScript( CHECKS_PAYLOAD );
	assert.ok( page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.editCheck.checks' ] );
} );

test( 'nothing is touched when the switch is off, but the page still says so', async () => {
	const { page, reports } = await startPage(
		{ active: false, reason: 'switched-off', patches: [] } );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { registered: [] };' );
	page.runScript( CHECKS_PAYLOAD );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 100 );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ], [ 'AddReference' ] );
	// Silence would look the same as a broken install, so the page reports
	// that it ran and did nothing, and why.
	assert.ok( reports.length > 0, 'the page must say it ran' );
	assert.equal( reports.at( -1 ).active, false );
	assert.equal( reports.at( -1 ).reason, 'switched-off' );
	assert.equal( reports.at( -1 ).files.length, 0 );
} );

test( 'a page that is patched says so in the same report', async () => {
	const { reports } = await runChecksModule( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/SourceVerificationEditCheck.js',
			kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js', 'init.js' ],
			source: "mw.editcheck.registered.push( 'SourceVerification' );"
		} ]
	} ) );
	assert.equal( reports.at( -1 ).active, true );
	assert.equal( reports.at( -1 ).reason, null );
} );

test( 'a credential page refuses every patch', async () => {
	const { page, reports } = await startPage( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/X.js', kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js' ],
			source: 'mw.editcheck.registered.push( "X" );'
		} ]
	} ) );
	bootMediaWiki( page );
	page.runScript(
		'mw.config.set( "wgCanonicalSpecialPageName", "Userlogin" );' +
		'mw.editcheck = { registered: [] };'
	);
	page.runScript( CHECKS_PAYLOAD );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 100 );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ], [ 'AddReference' ] );
	const row = reports.at( -1 ).files.find( ( f ) => f.status === 'blocked-page' );
	assert.match( row.reason, /Userlogin/ );
} );

test( 'an elevated account must confirm first', async () => {
	const { page, reports } = await startPage( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/X.js', kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js' ],
			source: 'mw.editcheck.registered.push( "X" );'
		} ]
	} ) );
	bootMediaWiki( page );
	page.runScript(
		'mw.config.set( "wgUserGroups", [ "user", "interface-admin" ] );' +
		'mw.editcheck = { registered: [] };'
	);
	page.runScript( CHECKS_PAYLOAD );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 100 );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ], [ 'AddReference' ] );
	const row = reports.at( -1 ).files.find( ( f ) => f.status === 'blocked-elevated' );
	assert.match( row.reason, /interface-admin/ );
} );

test( 'styles are injected as one style element at the end of the head', async () => {
	const { page } = await startPage( patchWith( {
		styles: [ { path: 'editcheck/modules/styles/X.less', css: '.x { color: red; }' } ]
	} ) );
	bootMediaWiki( page );
	page.runScript( CHECKS_PAYLOAD );
	await page.flush( 10 );
	const styles = page.document.head.children
		.filter( ( c ) => c.tagName === 'STYLE' && c.id === 'wikimedia-patched-styles' );
	assert.equal( styles.length, 1 );
	assert.match( styles[ 0 ].textContent, /\.x \{ color: red; \}/ );
	assert.equal( page.document.head.lastChild, styles[ 0 ],
		'the patch style must come last so it wins' );
} );

test( 'a module that loads before the bridge answers is still patched', async () => {
	// Start the page with no payload, so the bridge has not answered yet.
	const { page, reports, channel } = await startPage( null );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { registered: [] };' );
	page.runScript( CHECKS_PAYLOAD );
	await page.flush( 10 );

	// The bridge answers late.
	const payload = patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/Late.js',
			kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js' ],
			source: 'mw.editcheck.registered.push( "Late" );'
		} ]
	} );
	page.runScript(
		`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) }, ` +
		`{ detail: ${ JSON.stringify( payload ) } } ) );`
	);
	await page.flush( 10 );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 100 );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ],
		[ 'AddReference', 'Late' ] );
	const row = reports.at( -1 ).files.find( ( f ) => f.path.endsWith( 'Late.js' ) );
	assert.equal( row.status, 'applied-new' );
} );

// ---------------------------------------------------------------- replacement

/**
 * Build a module payload exactly as ResourceLoader writes one in debug
 * mode: a real function per file, with the source verbatim and a newline
 * before the closing brace.
 *
 * @param {string} name
 * @param {string} main
 * @param {Object<string,string>} files Key to file source.
 * @return {string}
 */
function modulePayload( name, main, files ) {
	const parts = Object.entries( files ).map( ( [ key, body ] ) =>
		`${ JSON.stringify( key ) }:function(require,module,exports){${ body }\n}` );
	return `mw.loader.impl(function(){return[${ JSON.stringify( name + '@' ) },` +
		`{"main":${ JSON.stringify( main ) },"files":{${ parts.join( ',' ) }}}];});`;
}

const OLD_CONTROLLER = "mw.editcheck.log.push( 'controller v1' );";
const OLD_INIT = "require( './controller.js' );";

async function runEditCheckModule( payload, { files, debug = true } = {} ) {
	const { page, reports } = await startPage( payload );
	bootMediaWiki( page, { debug } );
	page.runScript( 'mw.editcheck = { log: [] };' );
	page.runScript( modulePayload( 'ext.visualEditor.editCheck', 'editcheck/modules/init.js',
		files || {
			'editcheck/modules/controller.js': OLD_CONTROLLER,
			'editcheck/modules/init.js': OLD_INIT
		} ) );
	await page.flush( 10 );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	await page.flush( 100 );
	return { page, reports };
}

test( 'a changed file is replaced before the module runs', async () => {
	const { page, reports } = await runEditCheckModule( patchWith( {
		replaceFiles: [ {
			path: 'editcheck/modules/controller.js',
			kind: 'js',
			parentSource: OLD_CONTROLLER,
			source: "mw.editcheck.log.push( 'controller v2' );"
		} ]
	} ) );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v2' ],
		'the patched file ran, and the deployed one did not' );

	const row = reports.at( -1 ).files
		.find( ( f ) => f.path === 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'applied' );
	assert.match( row.reason, /runs the patch base/ );
} );

test( 'a new file is required by the module main file, in order', async () => {
	const { page, reports } = await runEditCheckModule( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/Extra.js',
			kind: 'js',
			siblings: [ 'controller.js', 'init.js' ],
			source: "mw.editcheck.log.push( 'extra' );"
		} ]
	} ) );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'controller v1', 'extra' ],
		'the added file runs as part of the module, after its own files' );
	const row = reports.at( -1 ).files.find( ( f ) => f.path === 'editcheck/modules/Extra.js' );
	assert.equal( row.status, 'applied-new' );
	assert.match( row.reason, /editcheck\/modules\/Extra\.js/ );
} );

test( 'replacing the main file and adding a file work together', async () => {
	const { page } = await runEditCheckModule( patchWith( {
		replaceFiles: [ {
			path: 'editcheck/modules/init.js',
			kind: 'js',
			parentSource: OLD_INIT,
			source: "mw.editcheck.log.push( 'new init' );"
		} ],
		newFiles: [ {
			path: 'editcheck/modules/Extra.js',
			kind: 'js',
			siblings: [ 'controller.js', 'init.js' ],
			source: "mw.editcheck.log.push( 'extra' );"
		} ]
	} ) );
	// The new main no longer loads controller.js, and the added file still runs.
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'new init', 'extra' ] );
} );

test( 'a combined script is left alone without debug mode, and says why', async () => {
	const { page, reports } = await startPage( patchWith( {
		replaceFiles: [ {
			path: 'resources/src/legacy/thing.js',
			kind: 'js',
			parentSource: 'old();',
			source: 'patched();'
		} ]
	} ) );
	bootMediaWiki( page, { debug: false } );
	page.runScript( 'mw.editcheck = { log: [] };' );
	page.runScript(
		'mw.loader.impl( function () { return [ "legacy.module@", ' +
		'function ( $, jQuery, require, module ) { mw.editcheck.log.push( "legacy" ); } ]; } );'
	);
	await page.flush( 10 );
	await page.window.mw.loader.using( 'legacy.module' );
	page.runScript( 'window.dispatchEvent( { type: "load" } );' );
	await page.flush( 1700 );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'legacy' ],
		'the module still works' );
	const row = reports.flatMap( ( r ) => r.files )
		.find( ( f ) => f.path === 'resources/src/legacy/thing.js' );
	assert.equal( row.status, 'not-on-page' );
	assert.match( row.reason, /one combined script.*debug mode/ );
} );

// ------------------------------------------------------------ skin styles

test( 'the page asks the worker to build the stylesheets its skin needs', async () => {
	const payload = patchWith( {
		pendingStyles: [
			{ path: 'editcheck/modules/styles/X.less', source: '@import "x";' }
		]
	} );
	const { page, reports, requests } = await startPage( payload, ( msg ) => {
		assert.equal( msg.type, 'get-styles' );
		// The worker cannot know these; only the page can.
		assert.equal( msg.skinKey, 'vector-2022' );
		assert.equal( msg.version, '1.47.0-wmf.20' );
		return {
			styles: [ {
				patchKey: '1321624@17',
				path: 'editcheck/modules/styles/X.less',
				css: '.sourceveri { color: red; }',
				reason: null
			} ]
		};
	} );

	bootMediaWiki( page );
	page.runScript(
		'mw.config.set( "skin", "vector-2022" );' +
		'mw.config.set( "wgVersion", "1.47.0-wmf.20" );' +
		'mw.editcheck = { registered: [] };'
	);
	page.runScript( CHECKS_PAYLOAD );
	await page.flush( 100 );

	assert.equal( requests.length, 1, 'the page asks once, not once per module' );
	const styles = page.document.head.children
		.filter( ( c ) => c.id === 'wikimedia-patched-styles' );
	assert.equal( styles.length, 1 );
	assert.match( styles[ 0 ].textContent, /\.sourceveri \{ color: red; \}/ );

	const row = reports.at( -1 ).files
		.find( ( f ) => f.path === 'editcheck/modules/styles/X.less' );
	assert.equal( row.status, 'style-injected' );
	assert.match( row.reason, /vector-2022/ );
} );

test( 'a stylesheet that will not build says why', async () => {
	const payload = patchWith( {
		pendingStyles: [
			{ path: 'editcheck/modules/styles/X.less', source: '@import "x";' }
		]
	} );
	const { page, reports } = await startPage( payload, () => ( {
		styles: [ {
			patchKey: '1321624@17',
			path: 'editcheck/modules/styles/X.less',
			css: null,
			reason: 'No LESS compiler is bundled. Run `npm install less` and build again.'
		} ]
	} ) );

	bootMediaWiki( page );
	page.runScript( 'mw.config.set( "skin", "vector-2022" ); mw.editcheck = { registered: [] };' );
	page.runScript( CHECKS_PAYLOAD );
	await page.flush( 100 );

	const row = reports.at( -1 ).files
		.find( ( f ) => f.path === 'editcheck/modules/styles/X.less' );
	assert.equal( row.status, 'style-skipped' );
	assert.match( row.reason, /npm install less/ );
} );

// ------------------------------------------------------------------- skew

/**
 * A controller file in three versions, like a real skewed patch: the base
 * the patch was written on, the wiki's older branch copy, and the patch.
 * Each line logs, so the test can see exactly which code ran.
 */
const log = ( ...names ) => names.map( ( n ) => `mw.editcheck.log.push( '${ n }' );` ).join( '\n' );
const SKEW_BASE = log( 'one', 'two', 'three', 'four', 'five', 'six' );
// The branch was cut before master changed line two.
const SKEW_WIKI = log( 'one', 'two-old', 'three', 'four', 'five', 'six' );
// The patch changes line five only.
const SKEW_PATCH = log( 'one', 'two', 'three', 'four', 'five-patched', 'six' );

function skewPatch( overrides = {} ) {
	return patchWith( {
		replaceFiles: [ {
			path: 'editcheck/modules/controller.js',
			kind: 'js',
			parentSource: SKEW_BASE,
			source: SKEW_PATCH,
			...overrides
		} ]
	} );
}

const skewFiles = ( controller ) => ( {
	'editcheck/modules/controller.js': controller,
	'editcheck/modules/init.js': OLD_INIT
} );

function rowFor( reports, path ) {
	return reports.at( -1 ).files.find( ( f ) => f.path === path );
}

test( 'on a skewed wiki only the patch changes are applied', async () => {
	const { page, reports } = await runEditCheckModule( skewPatch(),
		{ files: skewFiles( SKEW_WIKI ) } );

	// "two-old" stays, because that is what the wiki runs. Replacing the
	// whole file would have run master's "two" instead.
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two-old', 'three', 'four', 'five-patched', 'six' ] );
	const row = rowFor( reports, 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'merged' );
	assert.match( row.reason, /the running page/ );
} );

test( 'a merge that conflicts replaces the file and says what that costs', async () => {
	// The wiki changed line five too, differently.
	const wiki = log( 'one', 'two', 'three', 'four', 'five-backport', 'six' );
	const { page, reports } = await runEditCheckModule( skewPatch(),
		{ files: skewFiles( wiki ) } );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two', 'three', 'four', 'five-patched', 'six' ] );
	const row = rowFor( reports, 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'base-skew' );
	assert.match( row.reason, /would not merge/ );
	assert.match( row.reason, /removes 1 line\(s\) the wiki has/ );
} );

test( 'a wiki that already runs the patch is left alone', async () => {
	const { page, reports } = await runEditCheckModule( skewPatch(),
		{ files: skewFiles( SKEW_PATCH ) } );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two', 'three', 'four', 'five-patched', 'six' ] );
	const row = rowFor( reports, 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'applied' );
	assert.match( row.reason, /Already on the wiki/ );
} );

test( 'a wiki on the patch base gets the patched file', async () => {
	const { page, reports } = await runEditCheckModule( skewPatch(),
		{ files: skewFiles( SKEW_BASE ) } );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two', 'three', 'four', 'five-patched', 'six' ] );
	assert.match( rowFor( reports, 'editcheck/modules/controller.js' ).reason,
		/runs the patch base/ );
} );

test( 'without debug mode the deployed branch copy is used instead', async () => {
	// The live code is "minified" here: it must not be trusted.
	const { page, reports } = await runEditCheckModule(
		skewPatch( { deployed: { ref: 'wmf/1.47.0-wmf.20', source: SKEW_WIKI } } ),
		{ files: skewFiles( SKEW_WIKI ), debug: false } );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two-old', 'three', 'four', 'five-patched', 'six' ] );
	const row = rowFor( reports, 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'merged' );
	assert.match( row.reason, /wmf\/1\.47\.0-wmf\.20/ );
} );

test( 'without debug mode or a branch copy, the base is not checked', async () => {
	const { page, reports } = await runEditCheckModule( skewPatch(),
		{ files: skewFiles( SKEW_WIKI ), debug: false } );
	// Whole-file replacement is the only choice left.
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two', 'three', 'four', 'five-patched', 'six' ] );
	const row = rowFor( reports, 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'applied' );
	assert.match( row.reason, /not checked/ );
} );

test( 'a patch with no base from Gerrit is replaced and says so', async () => {
	const { reports } = await runEditCheckModule( skewPatch( { parentSource: null } ),
		{ files: skewFiles( SKEW_WIKI ) } );
	assert.match( rowFor( reports, 'editcheck/modules/controller.js' ).reason,
		/no base to compare/ );
} );

test( 'an added file the wiki already has is not registered twice', async () => {
	// The patch is merged and deployed: its new file is in the module.
	const already = "mw.editcheck.registered.push( 'SourceVerification' );";
	const { page, reports } = await startPage( patchWith( {
		newFiles: [ {
			path: 'editcheck/modules/editchecks/checks/SourceVerificationEditCheck.js',
			kind: 'js',
			siblings: [ 'AddReferenceEditCheck.js', 'init.js' ],
			source: already
		} ]
	} ) );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { registered: [] };' );
	page.runScript( modulePayload( 'ext.visualEditor.editCheck.checks', 'init.js', {
		'AddReferenceEditCheck.js': "mw.editcheck.registered.push( 'AddReference' );",
		'SourceVerificationEditCheck.js': already,
		'init.js': "require( './AddReferenceEditCheck.js' );\n" +
			"require( './SourceVerificationEditCheck.js' );"
	} ) );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 100 );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ],
		[ 'AddReference', 'SourceVerification' ] );
	const row = rowFor( reports,
		'editcheck/modules/editchecks/checks/SourceVerificationEditCheck.js' );
	assert.match( row.reason, /Already on the wiki/ );
} );

test( 'the page tells the worker which version it runs', async () => {
	const { page, reports } = await runEditCheckModule( skewPatch(),
		{ files: skewFiles( SKEW_BASE ) } );
	page.runScript( 'mw.config.set( "wgVersion", "1.47.0-wmf.20" );' );
	page.runScript( 'window.dispatchEvent( { type: "load" } );' );
	await page.flush( 1700 );
	assert.equal( reports.at( -1 ).version, '1.47.0-wmf.20' );
} );

test( 'a clean merge that is not valid code is never run', async () => {
	// Each side is valid alone, and the lines are far apart, so the merge is
	// clean. But both declare q, and together they do not parse.
	const base = log( 'one', 'two', 'three', 'four', 'five', 'six' );
	const wiki = base.replace( "mw.editcheck.log.push( 'one' );", 'const q = 1;' );
	const patch = base.replace( "mw.editcheck.log.push( 'five' );", 'const q = 2;' );
	const { page, reports } = await runEditCheckModule(
		patchWith( { replaceFiles: [ {
			path: 'editcheck/modules/controller.js', kind: 'js', parentSource: base, source: patch
		} ] } ),
		{ files: skewFiles( wiki ) } );

	// The patched file ran whole; the broken merge did not run at all.
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two', 'three', 'four', 'six' ] );
	const row = rowFor( reports, 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'base-skew' );
	assert.match( row.reason, /not valid JavaScript/ );
} );

// ---------------------------------------------------------------- holding

/**
 * Start a page whose bridge has not answered yet, and make a module
 * arrive the way a loader request does: marked "loading" first.
 */
async function pageWithSlowBridge() {
	const { page, reports, channel } = await startPage( null );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { log: [], registered: [] };' );
	const answer = ( payload ) => page.runScript(
		`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) }, ` +
		`{ detail: ${ JSON.stringify( payload ) } } ) );` );
	const respond = ( name, files ) => {
		page.runScript( `mw.loader._request( ${ JSON.stringify( name ) } );` );
		page.runScript( modulePayload( name, 'editcheck/modules/init.js', files ) );
	};
	return { page, reports, answer, respond };
}

const CONTROLLER_FILES = {
	'editcheck/modules/controller.js': OLD_CONTROLLER,
	'editcheck/modules/init.js': OLD_INIT
};
const CONTROLLER_PATCH = patchWith( {
	replaceFiles: [ {
		path: 'editcheck/modules/controller.js',
		kind: 'js',
		parentSource: OLD_CONTROLLER,
		source: "mw.editcheck.log.push( 'controller v2' );"
	} ]
} );

test( 'a requested module that arrives early waits for the patch', async () => {
	const { page, reports, answer, respond } = await pageWithSlowBridge();
	respond( 'ext.visualEditor.editCheck', CONTROLLER_FILES );

	// Still "loading": ResourceLoader has not seen the payload yet.
	const entry = () => page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.editCheck' ];
	assert.equal( entry().state, 'loading' );
	assert.equal( entry().script, undefined );

	const done = page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	answer( CONTROLLER_PATCH );
	await done;
	await page.flush( 100 );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v2' ],
		'the patched file ran, even though the module came first' );
	assert.equal( rowFor( reports, 'editcheck/modules/controller.js' ).status, 'applied' );
	assert.equal( reports.at( -1 ).held.count, 1 );
} );

test( 'an inline module never waits', async () => {
	// user.options is delivered in the page HTML, and the code after it
	// expects it at once. It is "registered", never "loading".
	const { page } = await pageWithSlowBridge();
	page.runScript( 'mw.loader.register( "user.options" );' );
	page.runScript( modulePayload( 'user.options', 'init.js', {
		'init.js': "mw.editcheck.log.push( 'options' );"
	} ) );
	assert.equal( page.window.mw.loader.moduleRegistry[ 'user.options' ].state, 'loaded' );
} );

test( 'a base module never waits', async () => {
	const { page } = await pageWithSlowBridge();
	page.runScript( 'mw.loader._request( "mediawiki.base" );' );
	page.runScript( modulePayload( 'mediawiki.base', 'init.js', { 'init.js': '' } ) );
	assert.equal( page.window.mw.loader.moduleRegistry[ 'mediawiki.base' ].state, 'loaded',
		'everything waits on the base modules, so they must not wait' );
} );

test( 'held modules are released in the order they arrived', async () => {
	const { page, answer, respond } = await pageWithSlowBridge();
	for ( const name of [ 'ext.a', 'ext.b', 'ext.c' ] ) {
		respond( name, { 'editcheck/modules/init.js': '' } );
	}
	assert.deepEqual( [ ...page.window.mw.loader._implOrder ], [],
		'nothing reaches ResourceLoader before the patch data' );
	answer( patchWith( {} ) );
	assert.deepEqual( [ ...page.window.mw.loader._implOrder ],
		[ 'ext.a', 'ext.b', 'ext.c' ] );
} );

test( 'one bad held module does not strand the others', async () => {
	const { page, answer } = await pageWithSlowBridge();
	page.runScript( 'mw.loader._request( "ext.bad" ); mw.loader._request( "ext.good" );' );
	page.runScript( 'mw.loader.impl( function () { return [ "ext.bad@", "__throw__" ]; } );' );
	page.runScript( modulePayload( 'ext.good', 'init.js', {
		'init.js': "mw.editcheck.log.push( 'good' );"
	} ) );
	answer( patchWith( {} ) );
	await page.window.mw.loader.using( 'ext.good' );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'good' ] );
} );

test( 'a bridge that never answers releases the modules unpatched', async () => {
	const { page, respond } = await pageWithSlowBridge();
	respond( 'ext.visualEditor.editCheck', CONTROLLER_FILES );
	// No answer. After the timeout the page carries on without patches.
	await page.flush( 2100 );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v1' ] );
} );

// --------------------------------------------------------------- stacking

/**
 * Two patches on one file, as a Gerrit chain gives: B is built on A.
 */
const STACK_WIKI = log( 'one', 'two', 'three', 'four', 'five', 'six' );
const STACK_A = log( 'one', 'two-A', 'three', 'four', 'five', 'six' );
const STACK_B = log( 'one', 'two-A', 'three', 'four', 'five-B', 'six' );

function stackPatch( key, parentSource, source, withDeployed ) {
	return {
		key, changeNumber: key, patchset: 1,
		project: 'mediawiki/extensions/VisualEditor',
		messages: {}, styles: [], newFiles: [], skipped: [], notes: [],
		replaceFiles: [ {
			path: 'editcheck/modules/controller.js', kind: 'js', parentSource, source,
			...( withDeployed ? { deployed: { ref: 'wmf/1.47.0-wmf.20', source: STACK_WIKI } } : {} )
		} ]
	};
}

async function runStack( order, { debug, deployed = true, a = STACK_A, b = STACK_B } = {} ) {
	const pa = stackPatch( 'A', STACK_WIKI, a, deployed );
	const pb = stackPatch( 'B', STACK_A, b, deployed );
	const payload = {
		active: true, reason: null, siteKind: 'dev', elevatedAck: false,
		patches: order === 'AB' ? [ pa, pb ] : [ pb, pa ]
	};
	return runEditCheckModule( payload, { files: skewFiles( STACK_WIKI ), debug } );
}

for ( const debug of [ true, false ] ) {
	for ( const order of [ 'AB', 'BA' ] ) {
		test( `two patches on one file both apply (${ debug ? '' : 'no ' }debug mode, ${ order })`,
			async () => {
				const { page, reports } = await runStack( order, { debug } );
				assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
					[ 'one', 'two-A', 'three', 'four', 'five-B', 'six' ],
					'neither patch may undo the other' );
				const rows = reports.at( -1 ).files;
				assert.ok( rows.every( ( r ) => [ 'applied', 'merged' ].includes( r.status ) ),
					JSON.stringify( rows ) );
			} );
	}
}

test( 'two patches that disagree keep the first and flag the second', async () => {
	// B changes the same line as A, differently, and is not built on it.
	const bad = log( 'one', 'two-B', 'three', 'four', 'five', 'six' );
	const pa = stackPatch( 'A', STACK_WIKI, STACK_A, true );
	const pb = stackPatch( 'B', STACK_WIKI, bad, true );
	const { page, reports } = await runEditCheckModule(
		{ active: true, reason: null, siteKind: 'dev', elevatedAck: false, patches: [ pa, pb ] },
		{ files: skewFiles( STACK_WIKI ), debug: false } );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ],
		[ 'one', 'two-A', 'three', 'four', 'five', 'six' ] );
	const rows = reports.at( -1 ).files;
	const b = rows.find( ( r ) => r.patchKey === 'B' );
	assert.equal( b.status, 'conflict' );
	assert.match( b.reason, /Kept A's version/ );
	assert.equal( rows.find( ( r ) => r.patchKey === 'A' ).status, 'applied' );
} );

// ----------------------------------------------------------------- splice

/**
 * A file of the VisualEditor library, long enough to be found by its text.
 * Each one logs its own name, so a test sees exactly which copy ran.
 */
function veFile( name, variant = '' ) {
	return `/*!\n * ${ name }: ` + 'padding so the text is long enough to find. '.repeat( 6 ) +
		`\n */\nmw.editcheck.log.push( '${ name }${ variant }' );\n` +
		`ve.${ name } = function () {};\nve.${ name }.prototype.size = 1;\n`;
}

/** Serve a scripts module the way ResourceLoader does in debug mode. */
function scriptsPayload( name, files ) {
	return `mw.loader.impl(function(){return[${ JSON.stringify( name + '@' ) },` +
		`function($,jQuery,require,module){${ files.join( '\n' ) }\n}];});`;
}

function vePatch( key, { parent, source, deployed, prefixes = [ 'ext.visualEditor' ] } ) {
	return {
		key, changeNumber: key, patchset: 1, project: 'VisualEditor/VisualEditor',
		modulePrefixes: prefixes,
		messages: {}, styles: [], newFiles: [], skipped: [], notes: [],
		replaceFiles: [ {
			path: 'src/dm/ve.dm.LinearData.js',
			matchPath: 'lib/ve/src/dm/ve.dm.LinearData.js',
			kind: 'js', parentSource: parent, source,
			...( deployed ? { deployed: { ref: 'wmf/1.47.0-wmf.20', source: deployed } } : {} )
		} ]
	};
}

async function runVeCore( patches, { files, debug = true, module = 'ext.visualEditor.core' } = {} ) {
	const { page, reports } = await startPage(
		{ active: true, reason: null, siteKind: 'dev', elevatedAck: false, patches } );
	bootMediaWiki( page, { debug } );
	page.runScript( 'mw.editcheck = { log: [] }; window.ve = {};' );
	page.runScript( scriptsPayload( module,
		files || [ veFile( 'Surface' ), veFile( 'LinearData' ), veFile( 'Node' ) ] ) );
	await page.window.mw.loader.using( module );
	await page.flush( 100 );
	return { page, reports, log: () => [ ...page.runScript( 'mw.editcheck.log' ) ] };
}

const LINEAR_ROW = ( reports ) => reports.at( -1 ).files
	.find( ( f ) => f.path === 'src/dm/ve.dm.LinearData.js' );

test( 'a library file is swapped inside a combined script', async () => {
	const { log, reports } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ), source: veFile( 'LinearData', '-patched' )
	} ) ] );
	assert.deepEqual( log(), [ 'Surface', 'LinearData-patched', 'Node' ],
		'only the patched file changed, and its neighbours still ran' );
	const row = LINEAR_ROW( reports );
	assert.equal( row.status, 'applied' );
	assert.match( row.reason, /runs the patch base/ );
} );

test( 'a skewed library file is merged inside a combined script', async () => {
	// The wiki's branch has an older copy; the patch base is newer.
	const wiki = veFile( 'LinearData' ).replace( 'size = 1', 'size = 0' );
	const { log, page, reports } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ),
		source: veFile( 'LinearData', '-patched' ),
		deployed: wiki
	} ) ], { files: [ veFile( 'Surface' ), wiki, veFile( 'Node' ) ] } );

	assert.deepEqual( log(), [ 'Surface', 'LinearData-patched', 'Node' ] );
	assert.equal( page.runScript( 'new ve.LinearData().size' ), 0,
		"the wiki's own line stays; only the patch's change is added" );
	assert.equal( LINEAR_ROW( reports ).status, 'merged' );
} );

test( 'a library file the wiki runs in some other version is reported', async () => {
	const other = veFile( 'LinearData' ).replace( 'padding', 'PADDING' );
	const { log, page, reports } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ), source: veFile( 'LinearData', '-patched' )
	} ) ], { files: [ veFile( 'Surface' ), other, veFile( 'Node' ) ] } );
	assert.deepEqual( log(), [ 'Surface', 'LinearData', 'Node' ], 'nothing was guessed' );
	page.runScript( 'window.dispatchEvent( { type: "load" } );' );
	await page.flush( 1700 );
	assert.equal( LINEAR_ROW( reports ).status, 'not-on-page' );
} );

test( 'a combined script is not touched without debug mode', async () => {
	const { log } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ), source: veFile( 'LinearData', '-patched' )
	} ) ], { debug: false } );
	assert.deepEqual( log(), [ 'Surface', 'LinearData', 'Node' ] );
} );

test( 'a module outside the patch repository is not searched', async () => {
	const { log } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ), source: veFile( 'LinearData', '-patched' )
	} ) ], { module: 'ext.somethingElse' } );
	assert.deepEqual( log(), [ 'Surface', 'LinearData', 'Node' ] );
} );

for ( const order of [ 'AB', 'BA' ] ) {
	test( `two library patches on one file stack inside a combined script (${ order })`,
		async () => {
			const base = veFile( 'LinearData' );
			const a = base.replace( 'size = 1', 'size = 2' );
			const b = a.replace( "'LinearData'", "'LinearData-B'" );
			const pa = vePatch( 'A', { parent: base, source: a } );
			const pb = vePatch( 'B', { parent: a, source: b } );
			const { log, page, reports } = await runVeCore( order === 'AB' ? [ pa, pb ] : [ pb, pa ] );
			assert.deepEqual( log(), [ 'Surface', 'LinearData-B', 'Node' ] );
			assert.equal( page.runScript( 'new ve.LinearData().size' ), 2 );
			const rows = reports.at( -1 ).files;
			assert.deepEqual( [ ...rows.map( ( r ) => r.patchKey ) ].sort(), [ 'A', 'B' ],
				'both patches report on the file' );
		} );
}

test( 'a splice that breaks the combined script is not run', async () => {
	// Fine alone, but the combined script is one function scope, and
	// Surface already declares this name.
	const surface = veFile( 'Surface' ) + 'const shared = 1;\n';
	const patched = veFile( 'LinearData', '-patched' ) + 'const shared = 2;\n';
	const { log, reports } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ), source: patched
	} ) ], { files: [ surface, veFile( 'LinearData' ), veFile( 'Node' ) ] } );
	assert.deepEqual( log(), [ 'Surface', 'LinearData', 'Node' ], 'the module ran unchanged' );
	const row = LINEAR_ROW( reports );
	assert.equal( row.status, 'base-skew' );
	assert.match( row.reason, /not valid JavaScript/ );
} );

test( 'a rebuilt module carries no source map that would break the CSP', async () => {
	// ext.visualEditor.core has DOMPurify inside, with a relative source map
	// comment. Resolved against the patched module's sourceURL it became
	// wikimedia-patched://module/purify.js.map, which the wiki's CSP blocks.
	const dompurify = veFile( 'Purify' ) + '//# sourceMappingURL=purify.js.map\n';
	const { page, log } = await runVeCore( [ vePatch( 'P', {
		parent: veFile( 'LinearData' ),
		source: veFile( 'LinearData', '-patched' ) + '//# sourceMappingURL=LinearData.js.map\n'
	} ) ], { files: [ dompurify, veFile( 'LinearData' ), veFile( 'Node' ) ] } );

	assert.deepEqual( log(), [ 'Purify', 'LinearData-patched', 'Node' ] );
	const rebuilt = String( page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.core' ].script );
	assert.doesNotMatch( rebuilt, /sourceMappingURL/ );
	assert.match( rebuilt, /sourceURL=wikimedia-patched:\/\/module\/ext\.visualEditor\.core/ );
} );

test( 'a replaced package file carries no source map either', async () => {
	const { page } = await runEditCheckModule( patchWith( {
		replaceFiles: [ {
			path: 'editcheck/modules/controller.js', kind: 'js', parentSource: OLD_CONTROLLER,
			source: "mw.editcheck.log.push( 'controller v2' );\n//# sourceMappingURL=controller.js.map"
		} ]
	} ) );
	const fn = page.window.mw.loader.moduleRegistry[ 'ext.visualEditor.editCheck' ]
		.script.files[ 'editcheck/modules/controller.js' ];
	assert.doesNotMatch( String( fn ), /sourceMappingURL/ );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v2' ] );
} );

// ---------------------------------------------------------------- logging

/** Run a page to the end, with a console that records what it was given. */
async function logsFor( payload ) {
	const logged = [];
	const record = ( level ) => ( ...args ) => logged.push( { level, text: args.join( ' ' ) } );
	const page = createPage( { console: {
		log: record( 'log' ), info: record( 'info' ), warn: record( 'warn' ), error: record( 'error' )
	} } );
	page.runFile( MAIN_WORLD );
	const channel = page.document.documentElement.dataset.wmpChannel;
	page.runScript(
		`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) }, ` +
		`{ detail: ${ JSON.stringify( payload ) } } ) );` );
	bootMediaWiki( page );
	page.runScript( 'window.dispatchEvent( { type: "load" } );' );
	await page.flush( 1700 );
	return logged.filter( ( l ) => l.text.includes( '[WikimediaPatched]' ) );
}

for ( const reason of [ 'switched-off', 'not-a-wiki', null ] ) {
	test( `an inactive page says nothing when the reason is ${ reason }`, async () => {
		assert.deepEqual( await logsFor( { active: false, reason, patches: [] } ), [] );
	} );
}

test( 'a production wiki waiting for confirmation is a notice, not a warning', async () => {
	const logs = await logsFor( { active: false, reason: 'production-not-acknowledged', patches: [] } );
	assert.deepEqual( logs.map( ( l ) => l.level ), [ 'info' ] );
	assert.match( logs[ 0 ].text, /confirm this production wiki/ );
} );

for ( const reason of [ 'timed-out', 'error', 'no-worker', 'something-new' ] ) {
	test( `a failure still warns (${ reason })`, async () => {
		const logs = await logsFor( { active: false, reason, patches: [] } );
		assert.deepEqual( logs.map( ( l ) => l.level ), [ 'warn' ] );
	} );
}

// ------------------------------------------------------------ slow bridge

test( 'patch data that comes late still patches the modules after it', async () => {
	// A cold worker reading Gerrit took 5.6s for change 1321624. VE loads
	// when the user starts to edit, long after that.
	const { page, reports, answer, respond } = await pageWithSlowBridge();
	await page.flush( 2500 );
	answer( CONTROLLER_PATCH );
	respond( 'ext.visualEditor.editCheck', CONTROLLER_FILES );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	await page.flush( 100 );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v2' ] );
	assert.equal( rowFor( reports, 'editcheck/modules/controller.js' ).status, 'applied' );
} );

test( 'a module released unpatched at the timeout is reported, and later ones are patched', async () => {
	const { page, reports, answer, respond } = await pageWithSlowBridge();
	// This one arrives early and cannot wait past the hold.
	respond( 'ext.early', { 'editcheck/modules/init.js': "mw.editcheck.log.push( 'early' );" } );
	await page.flush( 2200 );
	assert.equal( page.window.mw.loader.moduleRegistry[ 'ext.early' ].state, 'loaded',
		'released after the hold ran out' );

	answer( patchWith( {
		replaceFiles: [
			{ path: 'editcheck/modules/controller.js', kind: 'js', parentSource: OLD_CONTROLLER,
				source: "mw.editcheck.log.push( 'controller v2' );" }
		]
	} ) );
	respond( 'ext.visualEditor.editCheck', CONTROLLER_FILES );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	await page.flush( 100 );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v2' ] );
} );

// --------------------------------------------------------------- messages

/** A module that ships its own copy of a message, as core modules do. */
function moduleWithMessage( name, key, text ) {
	return `mw.loader.impl(function(){return[${ JSON.stringify( name + '@' ) },` +
		'{"main":"init.js","files":{"init.js":function(require,module,exports){}}},' +
		`{},${ JSON.stringify( { [ key ]: text } ) }];});`;
}

test( 'a changed message keeps the patched text after its module runs', async () => {
	// Core sets a module's own messages when it runs, which used to put
	// the deployed text back while the popup said "applied".
	const { page } = await startPage( patchWith( {
		messages: { 'editcheck-dialog-title': 'Patched title' }
	} ) );
	bootMediaWiki( page );
	page.runScript( moduleWithMessage( 'ext.visualEditor.editCheck',
		'editcheck-dialog-title', 'Deployed title' ) );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	assert.equal( page.window.mw.messages.get( 'editcheck-dialog-title' ), 'Patched title' );
} );

test( 'a module that arrived before the data still gets the patched message', async () => {
	const { page, channel } = await startPage( null );
	bootMediaWiki( page );
	page.runScript( moduleWithMessage( 'ext.visualEditor.editCheck',
		'editcheck-dialog-title', 'Deployed title' ) );
	page.runScript(
		`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) }, ` +
		`{ detail: ${ JSON.stringify( patchWith( {
			messages: { 'editcheck-dialog-title': 'Patched title' } } ) ) } } ) );` );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck' );
	assert.equal( page.window.mw.messages.get( 'editcheck-dialog-title' ), 'Patched title' );
} );

// ------------------------------------------------------ guard covers all

async function guardedPage( configScript ) {
	const { page } = await startPage( patchWith( {
		messages: { 'login-title': 'from a patch' },
		styles: [ { path: 'a.css', css: 'input[type=password] { background: red; }' } ]
	} ) );
	bootMediaWiki( page );
	// As core does: config first, then the first module.
	page.runScript( configScript );
	page.runScript( CHECKS_PAYLOAD.replace( 'mw.editcheck.registered.push', 'void' ) );
	page.runScript( 'window.dispatchEvent( { type: "load" } );' );
	await page.flush( 1700 );
	return {
		message: page.window.mw.messages.get( 'login-title' ),
		css: page.document.head.children.some( ( c ) => c.id === 'wikimedia-patched-styles' )
	};
}

test( 'a credential page gets no patch messages or styles either', async () => {
	const got = await guardedPage( 'mw.config.set( "wgCanonicalSpecialPageName", "Userlogin" );' );
	assert.deepEqual( got, { message: null, css: false } );
} );

test( 'an unconfirmed elevated account gets no patch messages or styles', async () => {
	const got = await guardedPage( 'mw.config.set( "wgUserGroups", [ "sysop" ] );' );
	assert.deepEqual( got, { message: null, css: false } );
} );

test( 'an ordinary page gets both', async () => {
	const got = await guardedPage( 'mw.config.set( "wgPageName", "Earth" );' );
	assert.deepEqual( got, { message: 'from a patch', css: true } );
} );
