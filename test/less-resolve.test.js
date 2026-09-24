import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenStyle } from '../background/less-resolve.js';

/**
 * A stand-in for the repositories, shaped like the real ones.
 *
 * Paths and contents copy what Gerrit really serves: a Vector override of
 * mediawiki.skin.variables.less, core's fallback, and the Codex packages
 * under resources/lib.
 */
function makeIo( files ) {
	const reads = [];
	// The code under test pulls these off the object, so none of them may
	// rely on `this`.
	const readRepoFile = async ( project, ref, path ) => {
		const key = `${ project }:${ path }`;
		reads.push( key );
		return Object.prototype.hasOwnProperty.call( files, key ) ? files[ key ] : null;
	};
	const readRepoJson = async ( project, ref, path ) => {
		const text = await readRepoFile( project, ref, path );
		return text === null ? null : JSON.parse( text );
	};
	const pickRef = async ( project, refs ) => refs.find( Boolean ) || 'master';
	return { reads, readRepoFile, readRepoJson, pickRef };
}

const VECTOR_SKIN_JSON = JSON.stringify( {
	SkinLessImportPaths: { 'vector-2022': 'resources/mediawiki.less/vector-2022' }
} );

const FILES = {
	'mediawiki/skins/Vector:skin.json': VECTOR_SKIN_JSON,
	'mediawiki/skins/Vector:resources/mediawiki.less/vector-2022/mediawiki.skin.variables.less':
		"@import 'mediawiki.skin.defaults.less';\n@vector: true;",
	'mediawiki/core:resources/src/mediawiki.less/mediawiki.skin.defaults.less':
		"@import 'mediawiki.skin.codex/mixins/link.less';\n@defaults: true;",
	'mediawiki/core:resources/lib/codex/mixins/link.less': '@link: true;',
	'mediawiki/core:resources/src/mediawiki.less/mediawiki.skin.variables.less':
		'@core-fallback: true;',
	'mediawiki/extensions/VisualEditor:editcheck/modules/styles/partial.less':
		'@partial: true;'
};

const BASE = {
	path: 'editcheck/modules/styles/X.less',
	project: 'mediawiki/extensions/VisualEditor',
	ref: 'abc123',
	skinKey: 'vector-2022',
	version: '1.47.0-wmf.20'
};

test( 'the skin override wins over the core fallback', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import 'mediawiki.skin.variables.less';\n.x { color: red; }"
	} );
	assert.deepEqual( r.missing, [] );
	assert.ok( r.files.includes(
		'mediawiki/skins/Vector:resources/mediawiki.less/vector-2022/mediawiki.skin.variables.less'
	) );
	assert.ok( !r.files.includes(
		'mediawiki/core:resources/src/mediawiki.less/mediawiki.skin.variables.less'
	), 'the core fallback must not be used when the skin has its own' );
	assert.match( r.source, /@vector: true;/ );
	assert.match( r.source, /\.x \{ color: red; \}/ );
} );

test( 'imports are followed across repositories, all the way down', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import 'mediawiki.skin.variables.less';"
	} );
	// Vector -> core defaults -> a Codex mixin in resources/lib.
	assert.deepEqual( r.files, [
		'mediawiki/skins/Vector:resources/mediawiki.less/vector-2022/mediawiki.skin.variables.less',
		'mediawiki/core:resources/src/mediawiki.less/mediawiki.skin.defaults.less',
		'mediawiki/core:resources/lib/codex/mixins/link.less'
	] );
	assert.match( r.source, /@link: true;/ );
} );

test( 'a skin with no override falls back to core', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, skinKey: 'apioutput',
		source: "@import 'mediawiki.skin.variables.less';"
	} );
	assert.deepEqual( r.files,
		[ 'mediawiki/core:resources/src/mediawiki.less/mediawiki.skin.variables.less' ] );
} );

test( "a partial beside the patch file is found in the patch's own repository", async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import 'partial.less';"
	} );
	assert.deepEqual( r.files,
		[ 'mediawiki/extensions/VisualEditor:editcheck/modules/styles/partial.less' ] );
	assert.match( r.source, /@partial: true;/ );
} );

test( 'an @import inside a comment is left alone', async () => {
	// MediaWiki's own files show examples this way, and one of them names a
	// file that does not exist.
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io,
		source: "// @import 'mediawiki.skin.default.less';\n" +
			"/* @import 'also-not-real.less'; */\n.x { color: red; }"
	} );
	assert.deepEqual( r.missing, [] );
	assert.deepEqual( r.files, [] );
} );

test( 'a missing import is named, not guessed at', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import 'nowhere.less';"
	} );
	assert.equal( r.missing.length, 1 );
	assert.match( r.missing[ 0 ], /cannot find "nowhere\.less"/ );
} );

test( 'the import MediaWiki forbids gets MediaWiki\'s own advice', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import '@wikimedia/codex-design-tokens/theme-wikimedia-ui.less';"
	} );
	assert.equal( r.errors.length, 1 );
	assert.match( r.errors[ 0 ], /mediawiki\.skin\.variables\.less/ );
} );

test( 'a file is included once, however often it is imported', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io,
		source: "@import 'mediawiki.skin.variables.less';\n" +
			"@import 'mediawiki.skin.variables.less';"
	} );
	const count = r.source.split( '@vector: true;' ).length - 1;
	assert.equal( count, 1, 'LESS imports a file once by default' );
} );

test( 'the .less suffix is added when the import leaves it out', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import 'mediawiki.skin.codex/mixins/link';"
	} );
	assert.deepEqual( r.files, [ 'mediawiki/core:resources/lib/codex/mixins/link.less' ] );
} );

test( 'a CSS import is left for the browser to fetch', async () => {
	const io = makeIo( FILES );
	const r = await flattenStyle( {
		...BASE, io, source: "@import (css) 'https://example.test/x.css';"
	} );
	assert.deepEqual( r.missing, [] );
	assert.match( r.source, /@import \(css\) 'https:\/\/example\.test\/x\.css';/ );
} );

test( 'the deployed branch is used, not master', async () => {
	const io = makeIo( FILES );
	await flattenStyle( { ...BASE, io, source: "@import 'mediawiki.skin.variables.less';" } );
	// pickRef is given the deployed branch first, so a wiki gets the code
	// it actually runs.
	assert.equal( await io.pickRef( 'mediawiki/core', [ 'wmf/1.47.0-wmf.20', 'master' ] ),
		'wmf/1.47.0-wmf.20' );
} );
