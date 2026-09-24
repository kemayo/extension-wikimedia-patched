import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalPatternFor } from '../shared/constants.js';
import {
	classifyProject, deployBranch, projectForSkin, modulePrefixesForProject,
	lessSearchDirs, mapLessPrefix, normalisePath, CORE_PROJECT
} from '../shared/mw-layout.js';

test( 'a Gerrit project says where a wiki keeps it', () => {
	assert.deepEqual( classifyProject( 'mediawiki/core' ),
		{ type: 'core', name: 'core', installPath: '' } );
	assert.deepEqual( classifyProject( 'mediawiki/extensions/VisualEditor' ),
		{ type: 'extension', name: 'VisualEditor', installPath: 'extensions/VisualEditor' } );
	assert.deepEqual( classifyProject( 'mediawiki/skins/Vector' ),
		{ type: 'skin', name: 'Vector', installPath: 'skins/Vector' } );
	assert.equal( classifyProject( 'operations/puppet' ).type, 'other' );
	// A sub-path is not an extension.
	assert.equal( classifyProject( 'mediawiki/extensions/Wikibase/lib' ).type, 'other' );
} );

test( 'the version a wiki reports gives its branch', () => {
	// Checked against en.wikipedia.org, which reported 1.47.0-wmf.20.
	assert.equal( deployBranch( '1.47.0-wmf.20' ), 'wmf/1.47.0-wmf.20' );
	assert.equal( deployBranch( '1.47.0-alpha' ), null );
	assert.equal( deployBranch( '1.43.1' ), null );
	assert.equal( deployBranch( undefined ), null );
} );

test( 'a skin key names the repository that provides it', () => {
	// Keys come from the siteinfo API of a live wiki.
	assert.equal( projectForSkin( 'vector-2022' ), 'mediawiki/skins/Vector' );
	assert.equal( projectForSkin( 'vector' ), 'mediawiki/skins/Vector' );
	assert.equal( projectForSkin( 'minerva' ), 'mediawiki/skins/MinervaNeue' );
	// An extension can provide a skin too.
	assert.equal( projectForSkin( 'contenttranslation' ),
		'mediawiki/extensions/ContentTranslation' );
	// Some skins are in core and have no repository of their own.
	assert.equal( projectForSkin( 'apioutput' ), CORE_PROJECT );
	assert.equal( projectForSkin( 'made-up' ), null );
} );

test( 'module name guesses follow the repository', () => {
	assert.deepEqual( modulePrefixesForProject( 'mediawiki/extensions/VisualEditor' ),
		[ 'ext.visualEditor', 'ext.VisualEditor' ] );
	assert.deepEqual( modulePrefixesForProject( 'mediawiki/skins/Vector' ), [ 'skins.vector' ] );
	assert.ok( modulePrefixesForProject( 'mediawiki/core' ).includes( 'mediawiki.' ) );
	assert.deepEqual( modulePrefixesForProject( 'operations/puppet' ), [] );
} );

test( 'the skin directory is searched before core', () => {
	const dirs = lessSearchDirs( {
		skinProject: 'mediawiki/skins/Vector',
		skinImportPath: 'resources/mediawiki.less/vector-2022',
		skinRef: 'wmf/1.47.0-wmf.20',
		coreRef: 'wmf/1.47.0-wmf.20'
	} );
	assert.deepEqual( dirs, [
		{
			project: 'mediawiki/skins/Vector',
			dir: 'resources/mediawiki.less/vector-2022',
			ref: 'wmf/1.47.0-wmf.20'
		},
		{
			project: CORE_PROJECT,
			dir: 'resources/src/mediawiki.less',
			ref: 'wmf/1.47.0-wmf.20'
		}
	] );
} );

test( 'a skin with no import directory falls through to core', () => {
	const dirs = lessSearchDirs( {
		skinProject: 'mediawiki/skins/Timeless', skinImportPath: null,
		skinRef: 'master', coreRef: 'master'
	} );
	assert.equal( dirs.length, 1 );
	assert.equal( dirs[ 0 ].project, CORE_PROJECT );
} );

test( 'the Codex import names map into core', () => {
	assert.deepEqual( mapLessPrefix( 'mediawiki.skin.codex/mixins/link.less' ),
		{ project: CORE_PROJECT, path: 'resources/lib/codex/mixins/link.less' } );
	assert.deepEqual( mapLessPrefix( 'mediawiki.skin.codex-design-tokens/theme-wikimedia-ui.less' ),
		{ project: CORE_PROJECT,
			path: 'resources/lib/codex-design-tokens/theme-wikimedia-ui.less' } );
	assert.equal( mapLessPrefix( 'mediawiki.skin.variables.less' ), null );
} );

test( 'normalisePath collapses dot segments', () => {
	assert.equal( normalisePath( 'a/b/../c.less' ), 'a/c.less' );
	assert.equal( normalisePath( 'a/./b.less' ), 'a/b.less' );
	assert.equal( normalisePath( './x.less' ), 'x.less' );
} );

test( 'an origin maps to the wildcard the manifest declares', () => {
	// A permission request must name a declared pattern, not a bare origin.
	assert.equal( optionalPatternFor( 'https://en.wikipedia.org' ),
		'https://*.wikipedia.org/*' );
	assert.equal( optionalPatternFor( 'https://commons.wikimedia.org' ),
		'https://*.wikimedia.org/*' );
	assert.equal( optionalPatternFor( 'https://www.mediawiki.org' ),
		'https://*.mediawiki.org/*' );
	assert.equal( optionalPatternFor( 'https://example.test' ), null );
} );
