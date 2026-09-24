import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, merge3, driftBetween } from '../shared/merge3.js';

const lines = ( ...xs ) => xs.join( '\n' ) + '\n';
const BASE = lines( 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h' );

test( 'diffLines describes a replacement in base coordinates', () => {
	const h = diffLines( [ 'a', 'b', 'c' ], [ 'a', 'B', 'c' ] );
	assert.deepEqual( h, [ { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 } ] );
} );

test( 'diffLines handles pure insertion and deletion', () => {
	assert.deepEqual( diffLines( [ 'a', 'c' ], [ 'a', 'b', 'c' ] ),
		[ { aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 } ] );
	assert.deepEqual( diffLines( [ 'a', 'b', 'c' ], [ 'a', 'c' ] ),
		[ { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 } ] );
	assert.deepEqual( diffLines( [ 'a' ], [ 'a' ] ), [] );
} );

test( 'changes far apart merge cleanly, and both survive', () => {
	const wiki = BASE.replace( 'b\n', 'B-wiki\n' );
	const patch = BASE.replace( 'g\n', 'G-patch\n' );
	const m = merge3( BASE, wiki, patch );
	assert.equal( m.clean, true );
	assert.equal( m.text, lines( 'a', 'B-wiki', 'c', 'd', 'e', 'f', 'G-patch', 'h' ) );
} );

test( 'the same lines changed two ways is a conflict', () => {
	const m = merge3( BASE, BASE.replace( 'd\n', 'D1\n' ), BASE.replace( 'd\n', 'D2\n' ) );
	assert.equal( m.clean, false );
	assert.equal( m.text, null );
	assert.deepEqual( m.conflicts, [ { baseStart: 4, baseEnd: 4 } ] );
} );

test( 'the same change on both sides is taken once', () => {
	// A patch that is already backported to the wiki's branch.
	const both = BASE.replace( 'd\n', 'D\n' );
	const m = merge3( BASE, both, both );
	assert.equal( m.clean, true );
	assert.equal( m.text, both );
} );

test( 'two different insertions at one point conflict', () => {
	const m = merge3( BASE, BASE.replace( 'c\n', 'c\nx\n' ), BASE.replace( 'c\n', 'c\ny\n' ) );
	assert.equal( m.clean, false );
} );

test( 'edits on adjacent lines conflict, because that is where merges go wrong', () => {
	const m = merge3( BASE, BASE.replace( 'c\n', 'C\n' ), BASE.replace( 'd\n', 'D\n' ) );
	assert.equal( m.clean, false );
} );

test( 'an unchanged side gives back the other side', () => {
	const patch = BASE.replace( 'e\n', 'E\n' );
	assert.equal( merge3( BASE, BASE, patch ).text, patch );
	const wiki = BASE.replace( 'e\n', 'E\n' );
	assert.equal( merge3( BASE, wiki, BASE ).text, wiki );
} );

test( 'Windows line endings do not count as changes', () => {
	const m = merge3( BASE, BASE.replace( /\n/g, '\r\n' ), BASE.replace( 'g\n', 'G\n' ) );
	assert.equal( m.clean, true );
	assert.equal( m.text, BASE.replace( 'g\n', 'G\n' ) );
} );

test( 'files with nothing in common are refused, not merged', () => {
	const many = ( tag ) => Array.from( { length: 1500 }, ( _, i ) => `${ tag }${ i }` ).join( '\n' );
	assert.equal( diffLines( many( 'a' ).split( '\n' ), many( 'b' ).split( '\n' ) ), null );
	const m = merge3( many( 'a' ), many( 'b' ), many( 'c' ) );
	assert.equal( m.clean, false );
	assert.match( m.reason, /too different/ );
} );

test( 'driftBetween counts what a whole-file replacement would change', () => {
	const wiki = BASE.replace( 'b\n', 'B1\nB2\n' );
	assert.deepEqual( driftBetween( wiki, BASE ), { onlyOurs: 2, onlyBase: 1 } );
	assert.deepEqual( driftBetween( BASE, BASE ), { onlyOurs: 0, onlyBase: 0 } );
} );

test( 'a merge adds to the wiki copy exactly what the patch adds', () => {
	// The property that makes a merge safe: nothing but the patch changes.
	const wiki = BASE.replace( 'a\n', 'A\n' ).replace( 'h\n', 'H1\nH2\n' );
	const patch = BASE.replace( 'd\n', 'd\nnew1\nnew2\n' ).replace( 'f\n', '' );
	const m = merge3( BASE, wiki, patch );
	assert.equal( m.clean, true );
	const patchDelta = diffLines( BASE.split( '\n' ), patch.split( '\n' ) );
	const mergeDelta = diffLines( wiki.split( '\n' ), m.text.split( '\n' ) );
	const count = ( hs ) => hs.map( ( h ) => [ h.aEnd - h.aStart, h.bEnd - h.bStart ] );
	assert.deepEqual( count( mergeDelta ), count( patchDelta ) );
} );
