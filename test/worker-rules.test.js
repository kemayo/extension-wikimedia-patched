import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * Rules Chrome enforces on a module service worker that Node does not.
 *
 * Node runs the worker's code happily with import(), so a unit test cannot
 * see the failure. Chrome refuses import() in a service worker, and the
 * LESS compiler was loaded that way: the import threw, and every
 * stylesheet was reported as "no compiler bundled". So check the rule on
 * the source, for every file the built worker loads.
 */

const ENTRY = 'dist/chrome/background/sw.js';

/** Every file reachable from the entry through static imports. */
function moduleGraph( entry ) {
	const seen = new Set();
	const todo = [ normalize( entry ) ];
	while ( todo.length ) {
		const file = todo.pop();
		if ( seen.has( file ) ) {
			continue;
		}
		seen.add( file );
		const text = readFileSync( file, 'utf8' );
		for ( const m of text.matchAll( /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g ) ) {
			todo.push( normalize( join( dirname( file ), m[ 1 ] ) ) );
		}
		for ( const m of text.matchAll( /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g ) ) {
			todo.push( normalize( join( dirname( file ), m[ 1 ] ) ) );
		}
	}
	return [ ...seen ];
}

/** Code with comments removed, roughly; good enough to find a call. */
function code( text ) {
	return text.replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /(^|[^:'"])\/\/[^\n]*/g, '$1' );
}

test( 'the worker loads the whole LESS compiler', () => {
	const files = moduleGraph( ENTRY );
	assert.ok( files.some( ( f ) => f.endsWith( 'vendor/less.js' ) ) );
	assert.ok( files.length > 50, `only ${ files.length } files; the graph walk is broken` );
} );

test( 'nothing the worker loads uses import() or importScripts()', () => {
	const offenders = [];
	for ( const file of moduleGraph( ENTRY ) ) {
		const body = code( readFileSync( file, 'utf8' ) );
		if ( /(?:^|[^.\w$])import\s*\(/.test( body ) ) {
			offenders.push( `${ file }: import()` );
		}
		if ( /\bimportScripts\s*\(/.test( body ) ) {
			offenders.push( `${ file }: importScripts()` );
		}
	}
	assert.deepEqual( offenders, [], 'Chrome refuses these in a module service worker' );
} );
