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

test( 'the manifest version is the package version, in both browsers', () => {
	// A release overrides it with WMP_VERSION, from the tag.
	const pkg = JSON.parse( readFileSync( 'package.json', 'utf8' ) ).version;
	for ( const browser of [ 'chrome', 'firefox' ] ) {
		const manifest = JSON.parse( readFileSync( `dist/${ browser }/manifest.json`, 'utf8' ) );
		assert.equal( manifest.version, process.env.WMP_VERSION || pkg, browser );
	}
} );

test( 'only a release build tells Firefox where to find updates', () => {
	const gecko = JSON.parse( readFileSync( 'dist/firefox/manifest.json', 'utf8' ) )
		.browser_specific_settings.gecko;
	assert.equal( gecko.update_url, process.env.WMP_UPDATE_URL || undefined );
	const chrome = JSON.parse( readFileSync( 'dist/chrome/manifest.json', 'utf8' ) );
	assert.equal( chrome.browser_specific_settings, undefined, 'Chrome has no such key' );
} );

test( 'the Firefox manifest has the add-on id and the data declaration', () => {
	const gecko = JSON.parse( readFileSync( 'dist/firefox/manifest.json', 'utf8' ) )
		.browser_specific_settings.gecko;
	// The id is permanent: changing it makes a new add-on.
	assert.equal( gecko.id, 'wikimedia-patched@delink.dev' );
	assert.deepEqual( gecko.data_collection_permissions, { required: [ 'none' ] } );
} );
