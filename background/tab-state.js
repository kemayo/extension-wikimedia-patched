/**
 * Per-tab results, and painting the toolbar badge.
 *
 * What the badge says is decided in badge.js; this only holds the reports
 * and applies the result.
 */

import { ext } from '../shared/webext.js';

/** Tab id to the last report from that tab. */
const byTab = new Map();

export function setTabStatus( tabId, report ) {
	byTab.set( tabId, { ...report, at: Date.now() } );
}

export function getTabStatus( tabId ) {
	return byTab.get( tabId ) || null;
}

export function clearTabStatus( tabId ) {
	byTab.delete( tabId );
}

/**
 * @param {number} tabId
 * @param {{ text: string, colour: string, title: string }} badge
 */
export function paintBadge( tabId, badge ) {
	ext.action.setBadgeText( { tabId, text: badge.text } ).catch( () => {} );
	ext.action.setBadgeBackgroundColor( { tabId, color: badge.colour } ).catch( () => {} );
	ext.action.setTitle( { tabId, title: badge.title } ).catch( () => {} );
}

/**
 * Forget a tab's report when it closes or starts a new page.
 *
 * @param {function(number)} onLoaded Called some time after a page in the
 *   tab finishes loading, to repaint the badge. A page the content script
 *   never reached sends no report, so this is the only chance to show it.
 */
export function watchTabs( onLoaded ) {
	ext.tabs.onRemoved.addListener( ( tabId ) => clearTabStatus( tabId ) );
	ext.tabs.onUpdated.addListener( ( tabId, info ) => {
		if ( info.status === 'loading' ) {
			clearTabStatus( tabId );
			ext.action.setBadgeText( { tabId, text: '' } ).catch( () => {} );
		} else if ( info.status === 'complete' ) {
			// The page reports after it settles, so wait before judging.
			setTimeout( () => onLoaded( tabId ), 3000 );
		}
	} );
}
