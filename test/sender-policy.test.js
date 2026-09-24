import test from 'node:test';
import assert from 'node:assert/strict';
import { mayHandle, senderOrigin, FROM_PAGE } from '../background/sender-policy.js';
import { MSG } from '../shared/constants.js';

const ROOT = 'chrome-extension://abcdef/';
const PAGE = { tab: { id: 1 }, url: 'https://en.wikipedia.org/wiki/Earth',
	origin: 'https://en.wikipedia.org' };
const POPUP = { url: ROOT + 'popup/popup.html' };
// The options page opens in a tab, so it has one.
const OPTIONS = { tab: { id: 2 }, url: ROOT + 'options/options.html' };

test( 'a web page may only ask for its patches and report on itself', () => {
	for ( const type of FROM_PAGE ) {
		assert.equal( mayHandle( type, PAGE, ROOT ), true, type );
	}
	assert.deepEqual( [ ...FROM_PAGE ].sort(),
		[ MSG.GET_PAYLOAD, MSG.GET_STYLES, MSG.REPORT_STATUS ].sort() );
} );

test( 'a web page may not change what runs, or where', () => {
	for ( const type of Object.values( MSG ) ) {
		if ( !FROM_PAGE.has( type ) ) {
			assert.equal( mayHandle( type, PAGE, ROOT ), false, type );
		}
	}
} );

test( "the extension's own pages may do anything", () => {
	for ( const type of Object.values( MSG ) ) {
		assert.equal( mayHandle( type, POPUP, ROOT ), true, type );
		assert.equal( mayHandle( type, OPTIONS, ROOT ), true, type );
	}
} );

test( 'another extension, or a look-alike URL, is not ours', () => {
	assert.equal( mayHandle( MSG.ACK_SITE, { url: 'chrome-extension://other/popup.html' }, ROOT ), false );
	assert.equal( mayHandle( MSG.ACK_SITE, { url: 'https://evil.test/chrome-extension://abcdef/' }, ROOT ), false );
	assert.equal( mayHandle( MSG.ACK_SITE, {}, ROOT ), false );
} );

test( 'the origin comes from the URL where the browser gives none', () => {
	assert.equal( senderOrigin( PAGE ), 'https://en.wikipedia.org' );
	// Firefox does not set sender.origin.
	assert.equal( senderOrigin( { url: 'https://de.wikipedia.org/wiki/X' } ), 'https://de.wikipedia.org' );
	assert.equal( senderOrigin( { origin: 'null', url: 'https://x.test/' } ), 'https://x.test' );
	assert.equal( senderOrigin( {} ), null );
} );
