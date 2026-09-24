import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { compileLess, isPlainCss } from '../shared/less-compile.js';

/**
 * Node has no document, which is what a background service worker is like.
 * So a compile that works here works there. That is the whole point of
 * vendoring lib/less instead of the dist build, which reads
 * document.currentScript as it loads.
 */
const vendored = existsSync( new URL( '../vendor/less/index.js', import.meta.url ) );

test( 'plain CSS needs no compiler', () => {
	assert.equal( isPlainCss( 'a/b.css' ), true );
	assert.equal( isPlainCss( 'a/b.less' ), false );
} );

test( 'a missing compiler says how to get one', { skip: vendored }, async () => {
	const r = await compileLess( '.x { color: red; }' );
	assert.equal( r.ok, false );
	assert.match( r.reason, /npm install less/ );
} );

test( 'the compiler runs without a DOM', { skip: !vendored }, async () => {
	const r = await compileLess( '@c: #c00;\n.x { color: @c; .y { color: @c; } }' );
	assert.equal( r.reason, null );
	assert.equal( r.ok, true );
	assert.match( r.css, /\.x \{\n\s*color: #c00;/ );
	assert.match( r.css, /\.x \.y \{/, 'nesting is resolved' );
} );

test( 'Codex tokens become CSS custom properties with fallbacks',
	{ skip: !vendored }, async () => {
		// This is what makes one compiled blob correct in light and dark mode.
		const r = await compileLess(
			'@font-size-small: ~"var( --font-size-small, 0.875rem )";\n' +
			'.x { font-size: @font-size-small; }'
		);
		assert.equal( r.ok, true );
		assert.match( r.css, /var\( --font-size-small, 0\.875rem \)/ );
	} );

test( 'division follows the MediaWiki setting', { skip: !vendored }, async () => {
	// MediaWiki compiles with math: parens-division, so a bare slash stays
	// a slash and only parentheses divide.
	const r = await compileLess( '.x { a: 6px/2; b: (6px/2); }' );
	assert.equal( r.ok, true );
	assert.match( r.css, /a: 6px\/2;/ );
	assert.match( r.css, /b: 3px;/ );
} );

test( 'a syntax error is reported with its line', { skip: !vendored }, async () => {
	const r = await compileLess( '.x { color: red' );
	assert.equal( r.ok, false );
	assert.match( r.reason, /LESS did not compile at line 1/ );
} );

test( 'a LESS plugin cannot reach anything', { skip: !vendored }, async () => {
	// No file managers are registered, so nothing can be loaded from
	// anywhere. A patch that needs a plugin fails loudly instead.
	const r = await compileLess( '@plugin "something";\n.x { color: red; }' );
	assert.equal( r.ok, false );
	assert.match( r.reason, /file-manager/ );
} );
