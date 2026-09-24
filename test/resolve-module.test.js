import test from 'node:test';
import assert from 'node:assert/strict';
import {
	resolveRelativePath, matchFileToModule, inferModuleForNewFile
} from '../shared/resolve-module.js';

/**
 * The two VisualEditor modules of change 1321624. The first uses the
 * extension root as its base path, so its keys are repository paths. The
 * second is registered in PHP with the checks directory as its base path,
 * so its keys are bare file names.
 */
const VE_MODULES = [
	{
		name: 'ext.visualEditor.editCheck',
		files: [
			'editcheck/modules/init.js',
			'editcheck/modules/utils.js',
			'editcheck/modules/controller.js',
			'editcheck/modules/EditCheckAction.js',
			'editcheck/modules/EditCheckActionWidget.js',
			'editcheck/modules/config.json'
		]
	},
	{
		name: 'ext.visualEditor.editCheck.checks',
		files: [
			'AddReferenceEditCheck.js',
			'CitationNeededEditCheck.js',
			'ConvertReferenceEditCheck.js',
			'ToneEditCheck.js',
			'init.js'
		]
	}
];

test( 'resolveRelativePath matches the ResourceLoader rules', () => {
	assert.equal( resolveRelativePath( '../foo.js', 'resources/src/bar/bar.js' ),
		'resources/src/foo.js' );
	assert.equal( resolveRelativePath( './x.js', 'a/b.js' ), 'a/x.js' );
	assert.equal( resolveRelativePath( './x.js', 'b.js' ), 'x.js' );
	assert.equal( resolveRelativePath( 'ext.foo', 'a/b.js' ), null );
} );

test( 'an extension-root module matches on the repository path', () => {
	const r = matchFileToModule( 'editcheck/modules/controller.js', VE_MODULES );
	assert.equal( r.status, 'exact' );
	assert.deepEqual( r.matches, [
		{ module: 'ext.visualEditor.editCheck', key: 'editcheck/modules/controller.js' }
	] );
} );

test( 'a module with its own base path matches on a path suffix', () => {
	const r = matchFileToModule(
		'editcheck/modules/editchecks/checks/ToneEditCheck.js', VE_MODULES );
	assert.equal( r.status, 'suffix' );
	assert.deepEqual( r.matches, [
		{ module: 'ext.visualEditor.editCheck.checks', key: 'ToneEditCheck.js' }
	] );
} );

test( 'a suffix must be a whole path component', () => {
	// "init.js" must not match "myinit.js".
	const r = matchFileToModule( 'editcheck/modules/myinit.js', VE_MODULES );
	assert.equal( r.status, 'none' );
} );

test( 'two modules holding the same name are reported, not guessed', () => {
	const shared = [
		{ name: 'ext.a', files: [ 'init.js' ] },
		{ name: 'ext.b', files: [ 'init.js' ] }
	];
	const r = matchFileToModule( 'a/b/init.js', shared );
	assert.equal( r.status, 'ambiguous' );
	assert.equal( r.matches.length, 2 );
} );

test( 'a longer key wins over a shorter one', () => {
	const mixed = [
		{ name: 'ext.a', files: [ 'init.js' ] },
		{ name: 'ext.b', files: [ 'modules/init.js' ] }
	];
	const r = matchFileToModule( 'x/modules/init.js', mixed );
	assert.equal( r.status, 'suffix' );
	assert.deepEqual( r.matches, [ { module: 'ext.b', key: 'modules/init.js' } ] );
} );

test( 'a new file lands in the module that holds its siblings', () => {
	const r = inferModuleForNewFile(
		'editcheck/modules/editchecks/checks/SourceVerificationEditCheck.js',
		[ 'AddReferenceEditCheck.js', 'CitationNeededEditCheck.js', 'ToneEditCheck.js' ],
		VE_MODULES
	);
	assert.equal( r.status, 'siblings' );
	assert.equal( r.module, 'ext.visualEditor.editCheck.checks' );
	// The module uses bare names, so the new key is bare too.
	assert.equal( r.key, 'SourceVerificationEditCheck.js' );
} );

test( 'a new file lands beside another file of the same patch', () => {
	const r = inferModuleForNewFile(
		'editcheck/modules/NewThing.js', [], VE_MODULES,
		[ {
			repoPath: 'editcheck/modules/controller.js',
			module: 'ext.visualEditor.editCheck',
			key: 'editcheck/modules/controller.js'
		} ]
	);
	assert.equal( r.status, 'anchor' );
	assert.equal( r.module, 'ext.visualEditor.editCheck' );
	assert.equal( r.key, 'editcheck/modules/NewThing.js' );
} );

test( 'a new file lands in a module whose keys share its directory', () => {
	const r = inferModuleForNewFile( 'editcheck/modules/NewThing.js', [], VE_MODULES );
	assert.equal( r.status, 'directory' );
	assert.equal( r.module, 'ext.visualEditor.editCheck' );
	assert.equal( r.key, 'editcheck/modules/NewThing.js' );
} );

test( 'a new file with no evidence is reported, not guessed', () => {
	const r = inferModuleForNewFile( 'somewhere/else/Thing.js', [], VE_MODULES );
	assert.equal( r.status, 'none' );
	assert.equal( r.module, null );
} );

test( 'the sibling rule keeps the key shape of a nested module', () => {
	const modules = [ { name: 'ext.x', files: [ 'sub/dir/A.js', 'sub/dir/B.js' ] } ];
	const r = inferModuleForNewFile(
		'repo/root/sub/dir/C.js', [ 'A.js', 'B.js' ], modules );
	assert.equal( r.status, 'siblings' );
	assert.equal( r.key, 'sub/dir/C.js' );
} );
