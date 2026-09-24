/**
 * Clean up source text before the extension compiles it.
 */

/** A source map comment on a line of its own, in either old or new form. */
const SOURCE_MAP_LINE = /^([ \t]*)\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*$/gm;

/**
 * Blank every source map comment, keeping the line.
 *
 * A relative source map URL is resolved against the script's sourceURL.
 * The extension names its scripts wikimedia-patched://..., so DevTools
 * tried to fetch wikimedia-patched://module/purify.js.map, and the wiki's
 * Content-Security-Policy blocked it. The map would be wrong anyway: its
 * offsets are for the file as it was, not as patched or joined with
 * others. The line stays, so line numbers in a stack trace do not move.
 *
 * @param {string} text
 * @return {string}
 */
export function stripSourceMapComments( text ) {
	return String( text ).replace( SOURCE_MAP_LINE, '$1' );
}
