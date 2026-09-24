import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateManifest } from '../scripts/firefox-updates.mjs';

test( 'the update manifest has the shape Firefox reads', () => {
	const link = 'https://github.com/o/r/releases/download/v0.2.0/wikimedia-patched-firefox-0.2.0.xpi';
	assert.deepEqual( buildUpdateManifest( {
		id: 'wikimedia-patched@wikimedia.org', version: '0.2.0', link, hash: 'ab12'
	} ), {
		addons: {
			'wikimedia-patched@wikimedia.org': {
				updates: [ { version: '0.2.0', update_link: link, update_hash: 'sha256:ab12' } ]
			}
		}
	} );
} );

test( 'Firefox updates only over https', () => {
	assert.throws( () => buildUpdateManifest( {
		id: 'x', version: '1', link: 'http://example.test/x.xpi', hash: 'ab'
	} ), /only from https/ );
} );
