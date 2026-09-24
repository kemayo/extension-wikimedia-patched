import test from 'node:test';
import assert from 'node:assert/strict';
import { stackOrder, dependencyReport } from '../shared/stack-order.js';

let clock = 0;
function patch( changeNumber, extra = {} ) {
	return {
		key: `${ changeNumber }@1`, changeNumber: String( changeNumber ), patchset: 1,
		project: 'mediawiki/extensions/VisualEditor', addedAt: ++clock,
		deps: { ancestors: [], dependsOn: [] }, ...extra
	};
}

test( 'unrelated patches keep the order they were added in', () => {
	assert.deepEqual( stackOrder( [ patch( 1 ), patch( 2 ), patch( 3 ) ] ).order,
		[ '1@1', '2@1', '3@1' ] );
} );

test( 'a patch built on another goes after it, by parent revision', () => {
	// Added in the wrong order on purpose.
	const b = patch( 2, { sha: 'bbb', parentSha: 'aaa' } );
	const a = patch( 1, { sha: 'aaa', parentSha: 'base' } );
	const r = stackOrder( [ b, a ] );
	assert.deepEqual( r.order, [ '1@1', '2@1' ] );
	assert.deepEqual( r.after[ '2@1' ], [ '1@1' ] );
} );

test( 'a chain ancestor goes first even after a rebase changed its revision', () => {
	// The list has PS1 of 1; 2 is built on PS2, so the sha does not match.
	const b = patch( 2, { deps: { ancestors: [ { changeNumber: '1', patchset: 2 } ], dependsOn: [] } } );
	const a = patch( 1 );
	assert.deepEqual( stackOrder( [ b, a ] ).order, [ '1@1', '2@1' ] );
} );

test( 'a Depends-On target goes first, across repositories', () => {
	const ve = patch( 1334998, { deps: { ancestors: [], dependsOn: [
		{ changeNumber: '1335416', changeId: 'I7bcc', project: 'mediawiki/core' }
	] } } );
	const core = patch( 1335416, { project: 'mediawiki/core', changeId: 'I7bcc' } );
	assert.deepEqual( stackOrder( [ ve, core ] ).order, [ '1335416@1', '1334998@1' ] );
} );

test( 'a whole chain comes out in order', () => {
	const c = patch( 3, { sha: 'c', parentSha: 'b' } );
	const a = patch( 1, { sha: 'a', parentSha: 'base' } );
	const b = patch( 2, { sha: 'b', parentSha: 'a' } );
	assert.deepEqual( stackOrder( [ c, a, b ] ).order, [ '1@1', '2@1', '3@1' ] );
} );

test( 'a parent in another repository with the same sha is not a parent', () => {
	const b = patch( 2, { parentSha: 'aaa' } );
	const a = patch( 1, { sha: 'aaa', project: 'mediawiki/core' } );
	assert.deepEqual( stackOrder( [ b, a ] ).order, [ '2@1', '1@1' ] );
} );

test( 'a Depends-On loop keeps every patch, and says so', () => {
	const a = patch( 1, { deps: { ancestors: [], dependsOn: [ { changeNumber: '2' } ] } } );
	const b = patch( 2, { deps: { ancestors: [], dependsOn: [ { changeNumber: '1' } ] } } );
	const r = stackOrder( [ a, b ] );
	assert.equal( r.cycle, true );
	assert.deepEqual( [ ...r.order ].sort(), [ '1@1', '2@1' ] );
} );

test( 'a dependency in the list is met', () => {
	const ve = patch( 10, { deps: { ancestors: [], dependsOn: [
		{ changeNumber: '20', status: 'NEW', subject: 'core change' } ] } } );
	const rows = dependencyReport( ve, [ ve, patch( 20 ) ] );
	assert.deepEqual( rows.map( ( r ) => [ r.state, r.ok ] ), [ [ 'in-list', true ] ] );
} );

test( 'an open dependency that is not in the list is flagged', () => {
	const ve = patch( 10, { deps: { ancestors: [], dependsOn: [
		{ changeNumber: '20', status: 'NEW' } ] } } );
	const [ row ] = dependencyReport( ve, [ ve ] );
	assert.equal( row.state, 'not-added' );
	assert.equal( row.ok, false );
} );

test( 'merged is only enough when it is deployed to this wiki', () => {
	const ve = patch( 10, { deps: { ancestors: [], dependsOn: [
		{ changeNumber: '30', status: 'MERGED' }, { changeNumber: '31', status: 'MERGED' },
		{ changeNumber: '32', status: 'MERGED' } ] } } );
	const rows = dependencyReport( ve, [ ve ],
		{ 30: 'deployed', 31: 'not-deployed' } );
	assert.deepEqual( rows.map( ( r ) => [ r.changeNumber, r.state, r.ok ] ), [
		[ '30', 'deployed', true ],
		[ '31', 'not-deployed', false ],
		// Not checked yet, so not assumed.
		[ '32', 'unknown', false ]
	] );
	assert.match( rows[ 1 ].note, /not on this wiki's branch/ );
} );

test( 'a chain ancestor at another patchset is met, with a note', () => {
	const b = patch( 2, { deps: { ancestors: [
		{ changeNumber: '1', patchset: 3, status: 'NEW' } ], dependsOn: [] } } );
	const [ row ] = dependencyReport( b, [ b, patch( 1 ) ] );
	assert.equal( row.ok, true );
	assert.match( row.note, /PS3; the list has PS1/ );
} );

test( 'abandoned and unresolvable dependencies are named', () => {
	const p = patch( 1, { deps: { ancestors: [], dependsOn: [
		{ changeNumber: '5', status: 'ABANDONED' },
		{ ref: 'Ideadbeef', changeNumber: null, status: 'UNKNOWN' } ] } } );
	const rows = dependencyReport( p, [ p ] );
	assert.deepEqual( rows.map( ( r ) => r.state ), [ 'abandoned', 'unknown' ] );
	assert.match( rows[ 1 ].note, /Ideadbeef/ );
} );
