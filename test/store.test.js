import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale } from '../background/store.js';

test( 'a cached payload goes stale after six hours, and not before', () => {
	const hour = 60 * 60 * 1000;
	assert.equal( isStale( 0, 5 * hour ), false );
	assert.equal( isStale( 0, 6 * hour ), false );
	assert.equal( isStale( 0, 6 * hour + 1 ), true );
	assert.equal( isStale( undefined, 0 ), true, 'no time means read it again' );
} );
