import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// npm test builds first, so dist/ is this build.
const idIn = ( path ) => /export const BUILD_ID = '([^']+)';/.exec( readFileSync( path, 'utf8' ) )[ 1 ];

test( 'each build is stamped, so the popup can spot an old worker', () => {
	const chrome = idIn( 'dist/chrome/shared/constants.js' );
	assert.notEqual( chrome, 'dev', 'the build must replace the placeholder' );
	assert.equal( idIn( 'dist/firefox/shared/constants.js' ), chrome,
		'both browsers come from one build' );
	assert.equal( idIn( 'shared/constants.js' ), 'dev', 'the source is not changed' );
} );
