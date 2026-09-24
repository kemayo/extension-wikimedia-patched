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
async function startPage( payload ) {
	const page = createPage();
	page.runFile( MAIN_WORLD );

	const channel = page.document.documentElement.dataset.wmpChannel;
	assert.ok( channel, 'main-world.js must publish a channel' );

	const reports = [];
	page.document.addEventListener( channel + ':out', ( ev ) => reports.push( ev.detail ) );

	if ( payload ) {
		page.runScript(
			`document.dispatchEvent( new CustomEvent( ${ JSON.stringify( channel + ':in' ) }, ` +
			`{ detail: ${ JSON.stringify( payload ) } } ) );`
		);
	}
	await page.flush();
	return { page, reports, channel };
}

function patchWith( overrides ) {
	return {
		active: true,
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

test( 'messages are set before any module runs', async () => {
	const { page } = await startPage( patchWith( {
		messages: { 'editcheck-sourceveri-title': 'Check the source' }
	} ) );
	bootMediaWiki( page );
	assert.equal( page.window.mw.messages.get( 'editcheck-sourceveri-title' ),
		'Check the source' );
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

test( 'nothing is touched when the switch is off', async () => {
	const { page, reports } = await startPage( { active: false, reason: 'switched-off', patches: [] } );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { registered: [] };' );
	page.runScript( CHECKS_PAYLOAD );
	await page.window.mw.loader.using( 'ext.visualEditor.editCheck.checks' );
	await page.flush( 10 );
	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.registered' ) ], [ 'AddReference' ] );
	assert.equal( reports.length, 0 );
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

async function runEditCheckModule( payload ) {
	const { page, reports } = await startPage( payload );
	bootMediaWiki( page );
	page.runScript( 'mw.editcheck = { log: [] };' );
	page.runScript( modulePayload( 'ext.visualEditor.editCheck', 'editcheck/modules/init.js', {
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

test( 'a patch written against a different base is applied and flagged', async () => {
	const { page, reports } = await runEditCheckModule( patchWith( {
		replaceFiles: [ {
			path: 'editcheck/modules/controller.js',
			kind: 'js',
			// The wiki runs something else, as a wmf branch would.
			parentSource: "mw.editcheck.log.push( 'controller v0' );",
			source: "mw.editcheck.log.push( 'controller v2' );"
		} ]
	} ) );

	assert.deepEqual( [ ...page.runScript( 'mw.editcheck.log' ) ], [ 'controller v2' ],
		'skew warns, it does not block' );
	const row = reports.at( -1 ).files
		.find( ( f ) => f.path === 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'base-skew' );
	assert.match( row.reason, /different version/ );
} );

test( 'an unverifiable base is applied and said to be unchecked', async () => {
	const { reports } = await runEditCheckModule( patchWith( {
		replaceFiles: [ {
			path: 'editcheck/modules/controller.js',
			kind: 'js',
			parentSource: null,
			source: "mw.editcheck.log.push( 'controller v2' );"
		} ]
	} ) );
	const row = reports.at( -1 ).files
		.find( ( f ) => f.path === 'editcheck/modules/controller.js' );
	assert.equal( row.status, 'applied' );
	assert.match( row.reason, /not in debug mode/ );
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

test( 'a scripts-only module is left alone and reported', async () => {
	const { page, reports } = await startPage( patchWith( {
		replaceFiles: [ {
			path: 'resources/src/legacy/thing.js',
			kind: 'js',
			parentSource: 'old();',
			source: 'patched();'
		} ]
	} ) );
	bootMediaWiki( page );
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
	assert.match( row.reason, /do not use packageFiles/ );
} );
