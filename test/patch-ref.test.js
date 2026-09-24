import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatchRef } from '../background/gerrit.js';

test( 'accepts a bare change number', () => {
	assert.deepEqual( parsePatchRef( '1321624' ),
		{ type: 'number', id: '1321624', patchset: null } );
	assert.deepEqual( parsePatchRef( ' 1321624/17 ' ),
		{ type: 'number', id: '1321624', patchset: 17 } );
} );

test( 'accepts a Change-Id', () => {
	const id = 'I' + 'a'.repeat( 40 );
	assert.deepEqual( parsePatchRef( id ), { type: 'changeid', id, patchset: null } );
} );

test( 'accepts every Gerrit URL shape', () => {
	const cases = [
		[ 'https://gerrit.wikimedia.org/r/c/mediawiki/extensions/VisualEditor/+/1321624/17', 17 ],
		[ 'https://gerrit.wikimedia.org/r/c/mediawiki/core/+/1321624', null ],
		[ 'https://gerrit.wikimedia.org/r/#/c/1321624/3/', 3 ],
		[ 'https://gerrit.wikimedia.org/r/1321624', null ]
	];
	for ( const [ url, patchset ] of cases ) {
		assert.deepEqual( parsePatchRef( url ),
			{ type: 'number', id: '1321624', patchset }, url );
	}
} );

test( 'refuses anything that is not Gerrit', () => {
	assert.equal( parsePatchRef( 'https://example.com/r/c/x/+/1321624' ), null );
	assert.equal( parsePatchRef( 'https://gerrit.wikimedia.org.evil.test/r/+/1' ), null );
	assert.equal( parsePatchRef( '../../etc/passwd' ), null );
	assert.equal( parsePatchRef( '' ), null );
	assert.equal( parsePatchRef( 'not a change' ), null );
} );
