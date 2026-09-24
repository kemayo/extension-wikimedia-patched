/**
 * Who may send which message to the background worker.
 *
 * A content script runs on a wiki page, and the page can reach it: the
 * MAIN-world script shares the page's globals, and the bridge relays what
 * that script asks. So anything a content script may send, a gadget or a
 * user script on that wiki may send too. Only messages that are safe from
 * a hostile page may come from a tab. Everything that changes what runs,
 * or where, must come from the extension's own pages.
 *
 * Pure, so the rule can be tested.
 */

import { MSG } from '../shared/constants.js';

/** Safe from a hostile page: they only read, or report about that page. */
export const FROM_PAGE = new Set( [ MSG.GET_PAYLOAD, MSG.REPORT_STATUS, MSG.GET_STYLES ] );

/**
 * @param {string} type Message type.
 * @param {Object} sender runtime.MessageSender.
 * @param {string} extensionRoot runtime.getURL( '' ).
 * @return {boolean}
 */
export function mayHandle( type, sender, extensionRoot ) {
	if ( FROM_PAGE.has( type ) ) {
		return true;
	}
	// The popup and the options page. The options page opens in a tab, so
	// "has no tab" is not the test; where it was loaded from is.
	return typeof sender.url === 'string' && sender.url.startsWith( extensionRoot );
}

/**
 * The origin of the page a message came from.
 *
 * Chrome gives sender.origin; not every browser does, so fall back to the
 * URL, which all of them give.
 *
 * @param {Object} sender
 * @return {string|null}
 */
export function senderOrigin( sender ) {
	if ( sender.origin && sender.origin !== 'null' ) {
		return sender.origin;
	}
	try {
		return new URL( sender.url ).origin;
	} catch ( e ) {
		return null;
	}
}
