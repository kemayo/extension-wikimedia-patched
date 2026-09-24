import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	extractBody, normalise, compareBase, relativeRequirePath
} from '../shared/verify-base.js';

test( 'extractBody unwraps a ResourceLoader package file', () => {
	const fn = function ( require, module, exports ) {
		return 1;
	};
	assert.match( extractBody( String( fn ) ), /return 1;/ );
	assert.equal( extractBody( 'not a function' ), null );
} );

test( 'a real production payload body matches the file on disk', () => {
	// The fixture is a trimmed copy of a live en.wikipedia.org debug
	// response, so this checks the wire format the extension relies on.
	const text = readFileSync( 'test/fixtures/editcheck-checks.debug.js', 'utf8' );
	const start = text.indexOf( '"AddReferenceEditCheck.js":function(require,module,exports){' );
	assert.ok( start > -1, 'the fixture uses the expected wrapper' );
	const body = text.slice( start + '"AddReferenceEditCheck.js":function(require,module,exports){'.length );
	// The body is verbatim source, not a string and not minified.
	assert.match( body.slice( 0, 120 ), /^\/\*\*\n \* Edit check to prompt users/ );
} );

test( 'compareBase ignores line endings and trailing space', () => {
	const live = function ( require, module, exports ) {};
	const body = extractBody( String( live ) );
	assert.equal( compareBase( live, body ), 'match' );
	assert.equal( compareBase( live, body + '   \n' ), 'match' );
	assert.equal( compareBase( live, body + 'extra();' ), 'differs' );
	assert.equal( compareBase( live, null ), 'unknown' );
	assert.equal( compareBase( { not: 'a function' }, 'x' ), 'unknown' );
} );

test( 'normalise leaves real differences alone', () => {
	assert.notEqual( normalise( 'a();\nb();' ), normalise( 'a();\nc();' ) );
	assert.equal( normalise( 'a();\r\nb(); \n' ), normalise( 'a();\nb();' ) );
} );

test( 'relativeRequirePath matches how ResourceLoader resolves', () => {
	assert.equal( relativeRequirePath( 'init.js', 'X.js' ), './X.js' );
	assert.equal( relativeRequirePath( 'sub/main.js', 'sub/dir/x.js' ), './dir/x.js' );
	assert.equal( relativeRequirePath( 'a/main.js', 'b/x.js' ), '../b/x.js' );
	assert.equal( relativeRequirePath( 'a/b/main.js', 'x.js' ), '../../x.js' );
} );

test( 'relativeRequirePath agrees with the resolver', async () => {
	const { resolveRelativePath } = await import( '../shared/resolve-module.js' );
	const pairs = [
		[ 'init.js', 'X.js' ],
		[ 'sub/main.js', 'sub/dir/x.js' ],
		[ 'a/main.js', 'b/x.js' ],
		[ 'a/b/main.js', 'x.js' ],
		[ 'a/b/main.js', 'a/c/x.js' ]
	];
	for ( const [ from, to ] of pairs ) {
		assert.equal( resolveRelativePath( relativeRequirePath( from, to ), from ), to,
			`${ from } -> ${ to }` );
	}
} );
