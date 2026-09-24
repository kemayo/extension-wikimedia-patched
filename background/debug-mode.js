/**
 * Turn on ResourceLoader debug mode.
 *
 * Debug mode is not needed to replace a file, because the extension changes
 * data and not text. It is needed to compare the live file against the
 * patch parent, which is how the extension detects a stale base.
 *
 * Phase 4 replaces this cookie with a per-tab rewrite of the startup module
 * URL. The cookie has two problems: it is origin-wide, and the Wikimedia CDN
 * may ignore it for a logged-out reader.
 */

import { DEBUG_COOKIE } from '../shared/constants.js';

/**
 * Set the debug cookie on one wiki.
 *
 * The cookie has no expiry, so it is a session cookie and it goes away with
 * the browser.
 *
 * @param {string} origin
 * @return {Promise<boolean>} True if the cookie is set.
 */
export async function enableDebug( origin ) {
	try {
		await chrome.cookies.set( {
			url: origin + '/',
			name: DEBUG_COOKIE,
			value: 'true',
			path: '/'
		} );
		return true;
	} catch ( e ) {
		return false;
	}
}

/**
 * Remove the debug cookie from one wiki.
 *
 * @param {string} origin
 */
export async function disableDebug( origin ) {
	try {
		await chrome.cookies.remove( { url: origin + '/', name: DEBUG_COOKIE } );
	} catch ( e ) {
		// The cookie may already be gone, or the origin may not be granted.
	}
}

/**
 * Remove the debug cookie from every wiki the extension can reach.
 *
 * Call this at startup and at install. A browser crash can leave a user in
 * debug mode with no idea why the wiki became slow.
 */
export async function clearAllDebugCookies() {
	let cookies = [];
	try {
		cookies = await chrome.cookies.getAll( { name: DEBUG_COOKIE } );
	} catch ( e ) {
		return;
	}
	await Promise.all( cookies.map( ( c ) => {
		const scheme = c.secure ? 'https://' : 'http://';
		const host = c.domain.replace( /^\./, '' );
		return chrome.cookies.remove( {
			url: scheme + host + c.path,
			name: DEBUG_COOKIE
		} ).catch( () => {} );
	} ) );
}
