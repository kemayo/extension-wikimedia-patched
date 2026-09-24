import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeFor, COLOURS } from '../background/badge.js';

/** A tab where everything is ready, with one applied file. */
function ready( overrides = {} ) {
	return {
		origin: 'https://en.wikipedia.org', siteKind: 'prod', hasPermission: true,
		enabled: true, patchCount: 1, readyPatchCount: 1, unreviewedCount: 0,
		acknowledged: true,
		report: { active: true, reason: null, files: [ { path: 'a.js', status: 'applied' } ] },
		...overrides
	};
}

test( 'nothing to do shows nothing', () => {
	assert.equal( badgeFor( null ).text, '' );
	assert.equal( badgeFor( ready( { siteKind: null } ) ).text, '' );
	assert.equal( badgeFor( ready( { enabled: false } ) ).text, '', 'the switch is off' );
	assert.equal( badgeFor( ready( { patchCount: 0 } ) ).text, '' );
	// Reviewed but switched off on purpose is not a problem.
	assert.equal( badgeFor( ready( { readyPatchCount: 0 } ) ).text, '' );
} );

test( 'a production wiki waiting for confirmation is flagged', () => {
	const b = badgeFor( ready( { acknowledged: false, report: null } ) );
	assert.equal( b.text, '!' );
	assert.equal( b.colour, COLOURS.warn );
	assert.match( b.title, /production wiki/ );
} );

test( 'a missing site permission is flagged', () => {
	const b = badgeFor( ready( { hasPermission: false, report: null } ) );
	assert.equal( b.text, '!' );
	assert.match( b.title, /needs permission/ );
} );

test( 'a patch waiting for review is flagged', () => {
	const b = badgeFor( ready( { readyPatchCount: 0, unreviewedCount: 2 } ) );
	assert.equal( b.text, '!' );
	assert.match( b.title, /2 patch\(es\) waiting for review/ );
} );

test( 'an account with elevated rights is flagged in red', () => {
	// This used to show a green 0/1: blocked rows were in no colour set.
	const b = badgeFor( ready( { report: { active: true, files: [
		{ path: '(page)', status: 'blocked-elevated', reason: 'Your account has sysop.' }
	] } } ) );
	assert.equal( b.text, '!' );
	assert.equal( b.colour, COLOURS.bad );
	assert.match( b.title, /sysop/ );
} );

test( 'a credential page is quiet, but says why', () => {
	const b = badgeFor( ready( { report: { active: true, files: [
		{ path: '(page)', status: 'blocked-page', reason: 'Special:Userlogin handles credentials.' }
	] } } ) );
	assert.equal( b.text, 'off' );
	assert.match( b.title, /credentials/ );
} );

test( 'a page that never answered is marked unknown', () => {
	assert.equal( badgeFor( ready( { report: null } ) ).text, '?' );
} );

test( 'patch data that came too late is flagged in red', () => {
	const b = badgeFor( ready( { report: { active: false, reason: 'timed-out', files: [] } } ) );
	assert.equal( b.colour, COLOURS.bad );
	assert.match( b.title, /too late/ );
} );

test( 'applied files are counted, coloured by the worst result', () => {
	const files = ( ...statuses ) => ( { active: true, files: statuses.map(
		( status, i ) => ( { path: `f${ i }.js`, status } ) ) } );
	let b = badgeFor( ready( { report: files( 'applied', 'merged', 'server-side' ) } ) );
	assert.equal( b.text, '2/2', 'server-side files are not counted' );
	assert.equal( b.colour, COLOURS.good );
	b = badgeFor( ready( { report: files( 'applied', 'base-skew' ) } ) );
	assert.equal( b.text, '1/2' );
	assert.equal( b.colour, COLOURS.warn );
	b = badgeFor( ready( { report: files( 'applied', 'conflict' ) } ) );
	assert.equal( b.colour, COLOURS.bad );
} );
