/**
 * Turn on ResourceLoader debug mode.
 *
 * Debug mode is not needed to replace a file, because the extension changes
 * data and not text. It is needed to compare the live file against the
 * patch parent, which is how the extension detects a stale base.
 *
 * Two ways to do it:
 *
 * - A `resourceLoaderDebug` cookie. Simple, but it covers the whole origin,
 *   and the Wikimedia CDN may drop it for a logged-out reader.
 * - A rewrite of the startup module request, per tab. Context::getReqBase()
 *   puts `debug=2` into the startup module, and every later load.php call
 *   inherits it. So rewriting one request is enough. The URL is different,
 *   so the CDN cannot answer from cache.
 *
 * The rewrite needs a check in a real browser, so the cookie stays the
 * default. See README.
 */

import { ext } from '../shared/webext.js';
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
		await ext.cookies.set( {
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
		await ext.cookies.remove( { url: origin + '/', name: DEBUG_COOKIE } );
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
		cookies = await ext.cookies.getAll( { name: DEBUG_COOKIE } );
	} catch ( e ) {
		return;
	}
	await Promise.all( cookies.map( ( c ) => {
		const scheme = c.secure ? 'https://' : 'http://';
		const host = c.domain.replace( /^\./, '' );
		return ext.cookies.remove( {
			url: scheme + host + c.path,
			name: DEBUG_COOKIE
		} ).catch( () => {} );
	} ) );
}


// --------------------------------------------------- per-tab URL rewriting

/**
 * Pick one mechanism.
 *
 * Firefox has both APIs, and its blocking webRequest handles a query
 * change more predictably than its declarativeNetRequest does. So use
 * declarative rules only where blocking webRequest is gone.
 *
 * @return {boolean}
 */
function useDeclarativeRules() {
	const blocking = ext.webRequest && ext.webRequest.onBeforeRequest &&
		ext.webRequest.OnBeforeRequestOptions &&
		'BLOCKING' in ext.webRequest.OnBeforeRequestOptions;
	return !blocking && !!ext.declarativeNetRequest;
}

/** The startup module is the only request that needs changing. */
const STARTUP_FILTER = 'load.php?';
const RULE_ID_BASE = 7300;

/**
 * Make load.php requests in one tab ask for debug mode.
 *
 * Chrome uses declarativeNetRequest session rules, which disappear when the
 * browser closes. Firefox keeps blocking webRequest, so it redirects.
 *
 * @param {number} tabId
 */
export async function enableDebugForTab( tabId ) {
	if ( useDeclarativeRules() ) {
		await ext.declarativeNetRequest.updateSessionRules( {
			removeRuleIds: [ RULE_ID_BASE + tabId ],
			addRules: [ {
				id: RULE_ID_BASE + tabId,
				priority: 1,
				action: {
					type: 'redirect',
					redirect: {
						transform: {
							queryTransform: {
								addOrReplaceParams: [ { key: 'debug', value: '2' } ]
							}
						}
					}
				},
				condition: {
					urlFilter: STARTUP_FILTER,
					resourceTypes: [ 'script' ],
					tabIds: [ tabId ]
				}
			} ]
		} );
	}
}

/**
 * Stop rewriting requests in one tab.
 *
 * @param {number} tabId
 */
export async function disableDebugForTab( tabId ) {
	if ( useDeclarativeRules() ) {
		await ext.declarativeNetRequest.updateSessionRules( {
			removeRuleIds: [ RULE_ID_BASE + tabId ]
		} ).catch( () => {} );
	}
}

/**
 * Firefox has no declarativeNetRequest redirect with a query transform, but
 * it kept blocking webRequest. One listener does the same job.
 *
 * @param {function(string): boolean} isActiveTab
 */
export function installFirefoxRewrite( isActiveTab ) {
	if ( useDeclarativeRules() ) {
		return;
	}
	ext.webRequest.onBeforeRequest.addListener(
		( details ) => {
			if ( details.tabId < 0 || !isActiveTab( details.tabId ) ) {
				return {};
			}
			const url = new URL( details.url );
			if ( url.searchParams.get( 'debug' ) === '2' ) {
				return {};
			}
			url.searchParams.set( 'debug', '2' );
			return { redirectUrl: url.toString() };
		},
		{ urls: [ '*://*/*load.php*' ], types: [ 'script' ] },
		[ 'blocking' ]
	);
}
