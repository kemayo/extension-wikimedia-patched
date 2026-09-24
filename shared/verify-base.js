/**
 * Compare the code a wiki runs against the code the patch was written for.
 *
 * ResourceLoader wraps each packaged file as
 * `function(require,module,exports){<source>\n}`, with the source exactly as
 * it is on disk. In debug mode nothing is minified, so the body and the
 * file from Gerrit can be compared directly.
 *
 * A difference is normal, not an error: a patch targets master and a wiki
 * runs a wmf branch. The point is to tell the user, not to refuse.
 */

/**
 * Pull the body out of a wrapped package file.
 *
 * @param {string} fnSource Result of String( fn ).
 * @return {string|null} Null if the shape is not what we expect.
 */
export function extractBody( fnSource ) {
	const text = String( fnSource );
	const open = text.indexOf( '{' );
	const close = text.lastIndexOf( '}' );
	if ( open === -1 || close <= open ) {
		return null;
	}
	return text.slice( open + 1, close );
}

/** Ignore line endings and trailing space, which travel badly. */
export function normalise( text ) {
	return String( text )
		.replace( /\r\n?/g, '\n' )
		.replace( /[ \t]+$/gm, '' )
		.trim();
}

/**
 * Say whether the live file is the file the patch was written against.
 *
 * @param {Function|*} liveFile Value from the module's files map.
 * @param {string|null} parentSource File content at the patch parent.
 * @return {'match'|'differs'|'unknown'}
 */
export function compareBase( liveFile, parentSource ) {
	if ( typeof parentSource !== 'string' || typeof liveFile !== 'function' ) {
		return 'unknown';
	}
	const body = extractBody( liveFile );
	if ( body === null ) {
		return 'unknown';
	}
	return normalise( body ) === normalise( parentSource ) ? 'match' : 'differs';
}

/**
 * Build the require() argument that takes one package file to another.
 *
 * ResourceLoader resolves a relative require against the directory of the
 * file that calls it.
 *
 * @param {string} fromKey Key of the file that calls require.
 * @param {string} toKey Key of the wanted file.
 * @return {string}
 */
export function relativeRequirePath( fromKey, toKey ) {
	const fromDir = fromKey.split( '/' );
	fromDir.pop();
	const toParts = toKey.split( '/' );
	const toFile = toParts.pop();

	let same = 0;
	while ( same < fromDir.length && same < toParts.length &&
		fromDir[ same ] === toParts[ same ] ) {
		same++;
	}
	const up = fromDir.length - same;
	const down = toParts.slice( same );
	const prefix = up ? '../'.repeat( up ) : './';
	return prefix + [ ...down, toFile ].join( '/' );
}
