/**
 * Turn resolved LESS into CSS.
 *
 * The compiler is bundled at build time, from node_modules. The extension
 * never fetches a compiler: it is code, and code must ship in the package.
 *
 * The import is static on purpose. Chrome forbids import() in a service
 * worker, and an earlier version used it: the import threw, the catch
 * read that as "no compiler", and every stylesheet was skipped. The build
 * always writes vendor/less.js, as the compiler or as a stub that exports
 * null, so this import always resolves.
 */

import less from '../vendor/less.js';

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
	if ( !less ) {
		return {
			ok: false,
			css: null,
			reason: 'No LESS compiler is bundled. Run `npm install less` and build again.'
		};
	}
	if ( typeof less.render !== 'function' ) {
		// Bundled, but not in the shape expected. Say so, not "missing".
		return {
			ok: false,
			css: null,
			reason: 'The bundled LESS compiler has no render(). Check vendor/less.js.'
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
