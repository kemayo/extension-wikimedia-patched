import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSourceMapComments } from '../shared/source-text.js';

test( 'a source map comment is blanked, and its line kept', () => {
	// The shape DOMPurify has inside ext.visualEditor.core, and the one a
	// MobileFrontend dist bundle ends with.
	const text = 'a();\n//# sourceMappingURL=purify.js.map\nb();\n' +
		'//# sourceMappingURL=mobile.init.js.map.json';
	const out = stripSourceMapComments( text );
	assert.doesNotMatch( out, /sourceMappingURL/ );
	assert.equal( out.split( '\n' ).length, text.split( '\n' ).length,
		'line numbers in stack traces must not move' );
	assert.match( out, /^a\(\);\n\nb\(\);/ );
} );

test( 'the old //@ form and indented comments go too', () => {
	assert.equal( stripSourceMapComments( '  //@ sourceMappingURL=x.map' ), '  ' );
	assert.equal( stripSourceMapComments( '\t//#sourceMappingURL=x.map\r\ny' ), '\t\r\ny' );
} );

test( 'the same words in code or mid-line are left alone', () => {
	const code = 'var s = "//# sourceMappingURL=x.map"; x(); //# sourceMappingURL=y.map';
	assert.equal( stripSourceMapComments( code ), code );
	assert.equal( stripSourceMapComments( '//# sourceURL=keep.js' ), '//# sourceURL=keep.js' );
} );
