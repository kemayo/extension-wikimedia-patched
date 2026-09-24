import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDependsOn, ancestorsFrom, pickDependency } from '../background/deps.js';
import { parseLog, escapeRawNewlines } from '../background/gitiles.js';

test( 'Depends-On footers are read, once each', () => {
	const msg = 'Subject\n\nBody Depends-On: not-a-footer\n\n' +
		'Bug: T1\nDepends-On: I7bcc606c5c8495613c03c52cbf0ba1de74a39aa4\n' +
		'Depends-On: I7bcc606c5c8495613c03c52cbf0ba1de74a39aa4\n' +
		'Depends-On: https://gerrit.wikimedia.org/r/c/mediawiki/core/+/1335416\nChange-Id: Iabc';
	assert.deepEqual( parseDependsOn( msg ), [
		'I7bcc606c5c8495613c03c52cbf0ba1de74a39aa4',
		'https://gerrit.wikimedia.org/r/c/mediawiki/core/+/1335416'
	] );
} );

test( 'ancestors are what /related lists after the current revision', () => {
	// Shape of a real /related answer: newest first.
	const rel = [
		{ _change_number: 3, _revision_number: 1, change_id: 'I3', status: 'NEW',
			commit: { commit: 'ccc', subject: 'three' } },
		{ _change_number: 2, _revision_number: 4, change_id: 'I2', status: 'NEW',
			commit: { commit: 'bbb', subject: 'two' } },
		{ _change_number: 1, _revision_number: 2, change_id: 'I1', status: 'NEW',
			commit: { commit: 'aaa', subject: 'one' } }
	];
	assert.deepEqual( ancestorsFrom( rel, 'bbb' ).map( ( a ) => a.changeNumber ), [ '1' ] );
	assert.deepEqual( ancestorsFrom( rel, 'ccc' ).map( ( a ) => a.changeNumber ), [ '2', '1' ] );
	assert.deepEqual( ancestorsFrom( rel, 'unknown' ), [] );
} );

test( 'a Depends-On Change-Id means the master change, not a backport', () => {
	const hits = [
		{ _number: 9, branch: 'wmf/1.47.0-wmf.20', status: 'MERGED' },
		{ _number: 8, branch: 'master', status: 'MERGED' }
	];
	assert.equal( pickDependency( hits )._number, 8 );
	assert.equal( pickDependency( [] ), null );
} );

test( 'a real Gitiles log range parses, raw newlines and all', () => {
	// Captured from gerrit.wikimedia.org: the merged commits under change
	// 1321624 that wmf/1.47.0-wmf.20 did not have.
	const r = parseLog( readFileSync( 'test/fixtures/gitiles-log-range.json', 'utf8' ) );
	assert.equal( r.commits.length, 28 );
	assert.ok( r.commits.every( ( c ) => /^I[0-9a-f]{40}$/.test( c.changeId ) ) );
	assert.equal( r.more, false );
} );

test( 'escapeRawNewlines only touches newlines inside strings', () => {
	assert.deepEqual( JSON.parse( escapeRawNewlines( '{\n "a": "x\ny",\n "b": "q\\"z"\n}' ) ),
		{ a: 'x\ny', b: 'q"z' } );
} );
