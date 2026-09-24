import test from 'node:test';
import assert from 'node:assert/strict';
import {
	KIND, classifyPath, isClientSide, diffMessages, diffManifest, i18nRole
} from '../background/patch-model.js';

test( 'classifies the files of change 1321624', () => {
	const expected = {
		'editcheck/modules/controller.js': KIND.JS,
		'editcheck/modules/EditCheckAction.js': KIND.JS,
		'editcheck/modules/editchecks/checks/SourceVerificationEditCheck.js': KIND.JS,
		'editcheck/modules/styles/SourceVerificationEditCheck.less': KIND.LESS,
		'editcheck/i18n/en.json': KIND.I18N,
		'editcheck/i18n/qqq.json': KIND.I18N,
		'extension.json': KIND.MANIFEST,
		'includes/Hooks.php': KIND.SERVER,
		'tests/qunit/foo.js': KIND.TEST,
		'modules/data.json': KIND.DATA,
		'skin.json': KIND.MANIFEST
	};
	for ( const [ path, kind ] of Object.entries( expected ) ) {
		assert.equal( classifyPath( path ), kind, path );
	}
} );

test( 'server and test files are not client side', () => {
	assert.equal( isClientSide( KIND.SERVER ), false );
	assert.equal( isClientSide( KIND.TEST ), false );
	assert.equal( isClientSide( KIND.JS ), true );
} );

test( 'diffMessages finds added and changed keys, and skips metadata', () => {
	const before = JSON.stringify( { '@metadata': { authors: [ 'a' ] }, keep: 'x', edit: 'old' } );
	const after = JSON.stringify( {
		'@metadata': { authors: [ 'a', 'b' ] }, keep: 'x', edit: 'new', add: 'y'
	} );
	const diff = diffMessages( before, after );
	assert.deepEqual( diff.added, [ 'add' ] );
	assert.deepEqual( diff.changed, [ 'edit' ] );
	assert.deepEqual( diff.messages, { edit: 'new', add: 'y' } );
} );

test( 'diffMessages treats a new file as all added', () => {
	const diff = diffMessages( null, JSON.stringify( { a: '1' } ) );
	assert.deepEqual( diff.added, [ 'a' ] );
} );

test( 'diffManifest separates what the browser can do from what it cannot', () => {
	const before = JSON.stringify( {
		ResourceModules: {
			'ext.x': { styles: [ 'a.less' ], messages: [ 'm1' ], packageFiles: [ 'i.js' ] }
		},
		Hooks: { BeforePageDisplay: 'X' }
	} );
	const after = JSON.stringify( {
		ResourceModules: {
			'ext.x': {
				styles: [ 'a.less', 'b.less' ],
				messages: [ 'm1', 'm2' ],
				packageFiles: [ 'i.js', { name: 'n.js' } ]
			},
			'ext.y': { scripts: [ 'y.js' ] }
		},
		Hooks: { BeforePageDisplay: 'X', SkinBuildSidebar: 'Y' }
	} );
	const diff = diffManifest( before, after );
	assert.deepEqual( diff.addedStyles, { 'ext.x': [ 'b.less' ] } );
	assert.deepEqual( diff.addedMessages, { 'ext.x': [ 'm2' ] } );
	assert.deepEqual( diff.addedPackageFiles, { 'ext.x': [ 'n.js' ] } );
	assert.deepEqual( diff.newModules, [ 'ext.y' ] );
	assert.equal( diff.otherChanges, true );
} );

test( 'diffManifest reports no other change when only modules move', () => {
	const before = JSON.stringify( { ResourceModules: { 'ext.x': { styles: [] } } } );
	const after = JSON.stringify( { ResourceModules: { 'ext.x': { styles: [ 'a.css' ] } } } );
	assert.equal( diffManifest( before, after ).otherChanges, false );
} );

test( 'qqq.json is documentation, not a language', () => {
	assert.equal( i18nRole( 'editcheck/i18n/en.json' ), 'english' );
	assert.equal( i18nRole( 'editcheck/i18n/qqq.json' ), 'documentation' );
	assert.equal( i18nRole( 'i18n/de.json' ), 'translation' );
	assert.equal( i18nRole( 'i18n/api/en.json' ), 'english' );
} );
