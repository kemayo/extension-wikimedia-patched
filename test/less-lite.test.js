import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStyle } from '../shared/less-lite.js';

test( 'plain CSS passes through', () => {
	const r = prepareStyle( 'a.css', '.x { color: red; }' );
	assert.equal( r.ok, true );
	assert.equal( r.css, '.x { color: red; }' );
} );

test( 'LESS that is already CSS passes through', () => {
	assert.equal( prepareStyle( 'a.less', '.x { color: red; }' ).ok, true );
} );

test( 'an at-rule block is not nesting', () => {
	assert.equal( prepareStyle( 'a.less', '@media screen { .x { color: red; } }' ).ok, true );
} );

test( 'nesting and variables are refused until the compiler exists', () => {
	assert.match( prepareStyle( 'a.less', '.x { .y { color: red; } }' ).reason, /nesting/ );
	assert.match( prepareStyle( 'a.less', '@c: red;\n.x { color: @c; }' ).reason, /variables/ );
} );

test( 'an unresolvable import names itself', () => {
	const r = prepareStyle( 'a.less', "@import 'mediawiki.skin.variables.less';\n.x{color:red}" );
	assert.equal( r.ok, false );
	assert.match( r.reason, /mediawiki\.skin\.variables\.less/ );
} );

test( 'a comment cannot look like a variable', () => {
	assert.equal( prepareStyle( 'a.less', '/* @c: red; */\n.x { color: red; }' ).ok, true );
} );
