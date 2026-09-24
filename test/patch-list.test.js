import test from 'node:test';
import assert from 'node:assert/strict';
import { planAdd, latestPatchset } from '../background/patch-list.js';

const rec = ( n, ps, extra = {} ) => ( {
	key: `${ n }@${ ps }`, changeNumber: String( n ), patchset: ps,
	reviewed: false, enabled: false, addedAt: ps * 10, ...extra
} );

test( 'a new change joins the end of the list', () => {
	const r = planAdd( [ rec( 1, 1 ) ], rec( 2, 1 ) );
	assert.equal( r.added, true );
	assert.equal( r.replaced, null );
	assert.deepEqual( r.patches.map( ( p ) => p.key ), [ '1@1', '2@1' ] );
} );

test( 'the same patchset again changes nothing', () => {
	const list = [ rec( 1, 1, { reviewed: true } ) ];
	const r = planAdd( list, rec( 1, 1 ) );
	assert.equal( r.added, false );
	assert.equal( r.patches, list, 'a review must not be lost' );
} );

test( 'another patchset replaces the old one, in its place, unreviewed', () => {
	const list = [ rec( 1, 17, { reviewed: true, enabled: true, addedAt: 5 } ), rec( 2, 1 ) ];
	const r = planAdd( list, rec( 1, 18 ) );
	assert.equal( r.replaced.key, '1@17' );
	assert.deepEqual( r.patches.map( ( p ) => p.key ), [ '1@18', '2@1' ] );
	const next = r.patches[ 0 ];
	assert.equal( next.addedAt, 5, 'keeps its place in the order' );
	assert.equal( next.reviewed, false, 'new code needs a new review' );
	assert.equal( next.enabled, false );
} );

test( 'an older patchset replaces a newer one too, if that is what was asked', () => {
	const r = planAdd( [ rec( 1, 18 ) ], rec( 1, 17 ) );
	assert.deepEqual( r.patches.map( ( p ) => p.key ), [ '1@17' ] );
} );

test( 'the newest patchset is the highest number', () => {
	assert.equal( latestPatchset( { revisions: { a: { _number: 3 }, b: { _number: 17 } } } ), 17 );
	assert.equal( latestPatchset( {} ), null );
} );
