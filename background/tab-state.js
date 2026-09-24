/**
 * Per-tab results and the toolbar badge.
 *
 * A silent no-op reads to the user as "the patch is broken". So every file
 * gets a result, and the badge shows how many landed.
 */

import { ext } from '../shared/webext.js';
import { STATUS } from '../shared/constants.js';

/** Tab id to the last report from that tab. */
const byTab = new Map();

const GOOD = new Set( [
	STATUS.APPLIED, STATUS.APPLIED_NEW, STATUS.MERGED, STATUS.STYLE_INJECTED
] );
const BAD = new Set( [ STATUS.CONFLICT, STATUS.TIMED_OUT ] );
const WARN = new Set( [
	STATUS.BASE_SKEW, STATUS.AMBIGUOUS, STATUS.UNMATCHED, STATUS.STYLE_SKIPPED
] );

export function setTabStatus( tabId, report ) {
	byTab.set( tabId, { ...report, at: Date.now() } );
	updateBadge( tabId );
}

export function getTabStatus( tabId ) {
	return byTab.get( tabId ) || null;
}

export function clearTabStatus( tabId ) {
	byTab.delete( tabId );
}

/**
 * Show how many files landed, and colour by the worst result.
 *
 * @param {number} tabId
 */
export function updateBadge( tabId ) {
	const report = byTab.get( tabId );
	if ( !report || !report.files || !report.files.length ) {
		ext.action.setBadgeText( { tabId, text: '' } ).catch( () => {} );
		return;
	}
	const applied = report.files.filter( ( f ) => GOOD.has( f.status ) ).length;
	const total = report.files.filter( ( f ) => f.status !== STATUS.SERVER_SIDE ).length;
	const worst = report.files.some( ( f ) => BAD.has( f.status ) ) ? '#d73333' :
		report.files.some( ( f ) => WARN.has( f.status ) ) ? '#ac6600' : '#14866d';

	ext.action.setBadgeText( { tabId, text: `${ applied }/${ total }` } ).catch( () => {} );
	ext.action.setBadgeBackgroundColor( { tabId, color: worst } ).catch( () => {} );
}

/** Forget a tab when it closes, so the map cannot grow without limit. */
export function watchTabs() {
	ext.tabs.onRemoved.addListener( ( tabId ) => clearTabStatus( tabId ) );
	ext.tabs.onUpdated.addListener( ( tabId, info ) => {
		if ( info.status === 'loading' ) {
			clearTabStatus( tabId );
			ext.action.setBadgeText( { tabId, text: '' } ).catch( () => {} );
		}
	} );
}
