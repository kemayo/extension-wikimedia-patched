/**
 * Turn resolved LESS into CSS.
 *
 * The compiler is bundled at build time, from node_modules. The extension
 * never fetches a compiler: it is code, and code must ship in the package.
 */

let compiler;

async function getCompiler() {
	if ( compiler === undefined ) {
		try {
			compiler = ( await import( '../vendor/less.js' ) ).default;
		} catch ( e ) {
			compiler = null;
		}
	}
	return compiler;
}

/**
 * Compile a flattened stylesheet.
 *
 * Every import is already in place, so the compiler needs no file access.
 *
 * @param {string} source
 * @param {Object} [options]
 * @param {string} [options.filename] Only used in an error message.
 * @return {Promise<{ ok: boolean, css: string|null, reason: string|null }>}
 */
export async function compileLess( source, options = {} ) {
	const less = await getCompiler();
	if ( !less || typeof less.render !== 'function' ) {
		return {
			ok: false,
			css: null,
			reason: 'No LESS compiler is bundled. Run `npm install less` and build again.'
		};
	}
	try {
		const result = await less.render( source, {
			filename: options.filename || 'patch.less',
			// Every import is inline, so nothing may be fetched.
			syncImport: true,
			javascriptEnabled: false,
			math: 'parens-division',
			relativeUrls: false
		} );
		return { ok: true, css: result.css, reason: null };
	} catch ( e ) {
		const where = e.line ? ` at line ${ e.line }` : '';
		return {
			ok: false,
			css: null,
			reason: `LESS did not compile${ where }: ${ e.message || e }`
		};
	}
}

/** True when a stylesheet needs no compiler at all. */
export function isPlainCss( path ) {
	return /\.css$/i.test( path );
}
