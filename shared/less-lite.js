/**
 * Turn a patch stylesheet into CSS that the page can use.
 *
 * MediaWiki resolves `mediawiki.skin.variables.less` on the server, once per
 * skin. No endpoint serves the raw file, and a snapshot goes stale fast. So a
 * stylesheet that imports skin variables is reported as skipped, not guessed.
 */

/** Imports that the extension cannot resolve. */
const UNRESOLVABLE_IMPORT = /@import\s+(?:\([^)]*\)\s*)?['"]([^'"]+)['"]/g;

/**
 * Look at a stylesheet and decide if the extension can use it.
 *
 * @param {string} path Repository path.
 * @param {string} source File text.
 * @return {{ ok: boolean, css: string|null, reason: string|null }}
 */
export function prepareStyle( path, source ) {
	if ( /\.css$/i.test( path ) ) {
		return { ok: true, css: source, reason: null };
	}

	const imports = [];
	let m;
	UNRESOLVABLE_IMPORT.lastIndex = 0;
	while ( ( m = UNRESOLVABLE_IMPORT.exec( source ) ) !== null ) {
		imports.push( m[ 1 ] );
	}
	if ( imports.length ) {
		return {
			ok: false,
			css: null,
			reason: `Needs LESS imports the extension cannot resolve: ${ imports.join( ', ' ) }`
		};
	}

	// TODO(phase 2): compile with a bundled less.js. Until then only accept
	// LESS that is already valid CSS.
	const needs = [];
	if ( /(^|[^\w-])@[a-zA-Z][\w-]*\s*:/.test( stripComments( source ) ) ) {
		needs.push( 'variables' );
	}
	if ( hasNesting( source ) ) {
		needs.push( 'nesting' );
	}
	if ( needs.length ) {
		return {
			ok: false,
			css: null,
			reason: `Needs a LESS compiler (${ needs.join( ' and ' ) }). Not built yet.`
		};
	}

	return { ok: true, css: source, reason: null };
}

/** Remove comments so they cannot look like declarations. */
function stripComments( source ) {
	return source.replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /\/\/[^\n]*/g, '' );
}

/**
 * True if a rule opens inside another rule.
 *
 * Plain CSS nests only inside an at-rule such as @media or @supports, so a
 * block that opens inside anything else means LESS.
 *
 * @param {string} source
 * @return {boolean}
 */
function hasNesting( source ) {
	const text = stripComments( source );
	// Each entry says whether that open block came from an at-rule.
	const stack = [];
	let selector = '';
	for ( const ch of text ) {
		if ( ch === '{' ) {
			if ( stack.length && !stack[ stack.length - 1 ] ) {
				return true;
			}
			stack.push( /^\s*@/.test( selector ) );
			selector = '';
		} else if ( ch === '}' ) {
			stack.pop();
			selector = '';
		} else if ( ch === ';' ) {
			selector = '';
		} else {
			selector += ch;
		}
	}
	return false;
}
