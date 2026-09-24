/**
 * Background worker. Routes messages, talks to Gerrit, holds per-tab state.
 *
 * The worker can stop at any time, so all durable state lives in
 * chrome.storage. Only the per-tab report is in memory, and it is rebuilt on
 * the next page load.
 */

import {
	MSG, DEV_WIKI_MATCHES, PROD_WIKI_MATCHES, NON_WIKI_MATCHES
} from '../shared/constants.js';
import { parsePatchRef } from './gerrit.js';
import { preparePatch } from './prepare.js';
import * as store from './store.js';
import { enableDebug, disableDebug, clearAllDebugCookies } from './debug-mode.js';
import { setTabStatus, getTabStatus, watchTabs } from './tab-state.js';

/** Turn a match pattern into a host test. */
function matchToRegExp( pattern ) {
	const host = pattern.replace( /^https?:\/\//, '' ).replace( /\/.*$/, '' );
	return new RegExp( '^' + host.split( '*.' ).map( escapeRe ).join( '(?:[^.]+\\.)*' ) + '$' );
}
function escapeRe( s ) {
	return s.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

const DEV_HOSTS = DEV_WIKI_MATCHES.map( matchToRegExp );
const PROD_HOSTS = PROD_WIKI_MATCHES.map( matchToRegExp );
const NON_WIKI_HOSTS = NON_WIKI_MATCHES.map( matchToRegExp );

/**
 * Decide what kind of site an origin is.
 *
 * @param {string} origin
 * @return {'dev'|'prod'|null}
 */
export function classifyOrigin( origin ) {
	let host;
	try {
		host = new URL( origin ).hostname;
	} catch ( e ) {
		return null;
	}
	if ( NON_WIKI_HOSTS.some( ( re ) => re.test( host ) ) ) {
		return null;
	}
	if ( DEV_HOSTS.some( ( re ) => re.test( host ) ) ) {
		return 'dev';
	}
	if ( PROD_HOSTS.some( ( re ) => re.test( host ) ) ) {
		return 'prod';
	}
	return null;
}

/** Add a patch, after reading it from Gerrit. */
async function handleAddPatch( input ) {
	const ref = parsePatchRef( input );
	if ( !ref ) {
		throw new Error( 'Not a Gerrit change number, Change-Id or URL.' );
	}
	const payload = await preparePatch( ref );
	await store.setCachedPayload( payload.key, payload );
	await store.addPatch( {
		key: payload.key,
		changeNumber: payload.changeNumber,
		patchset: payload.patchset,
		sha: payload.sha,
		project: payload.project,
		branch: payload.branch,
		subject: payload.subject,
		owner: payload.owner,
		changeStatus: payload.status,
		// The user must look at the code before it runs on a wiki.
		reviewed: false,
		enabled: false,
		addedAt: Date.now()
	} );
	return payload;
}

/** Read a patch again from Gerrit, keeping the pinned patchset. */
async function handleRefreshPatch( key ) {
	const patches = await store.getPatches();
	const patch = patches.find( ( p ) => p.key === key );
	if ( !patch ) {
		throw new Error( 'No such patch.' );
	}
	const payload = await preparePatch( {
		type: 'number', id: patch.changeNumber, patchset: patch.patchset
	} );
	await store.setCachedPayload( key, payload );
	return payload;
}

/**
 * Collect everything a page needs.
 *
 * Only patches that the user reviewed and turned on are sent.
 *
 * @param {string} origin
 * @return {Promise<Object>}
 */
async function buildPagePayload( origin ) {
	const kind = classifyOrigin( origin );
	if ( !kind ) {
		return { active: false, reason: 'not-a-wiki', patches: [] };
	}
	if ( !await store.isEnabled() ) {
		return { active: false, reason: 'switched-off', patches: [] };
	}
	if ( kind === 'prod' && !await store.hasProductionAck( origin ) ) {
		return { active: false, reason: 'production-not-acknowledged', patches: [] };
	}

	const patches = ( await store.getPatches() ).filter( ( p ) => p.enabled && p.reviewed );
	const payloads = [];
	for ( const patch of patches ) {
		let payload = await store.getCachedPayload( patch.key );
		if ( !payload ) {
			try {
				payload = await handleRefreshPatch( patch.key );
			} catch ( e ) {
				continue;
			}
		}
		payloads.push( payload );
	}
	return { active: payloads.length > 0, reason: null, siteKind: kind, patches: payloads };
}

/** Handle one message. Split out so the listener can stay small. */
async function dispatch( msg, sender ) {
	switch ( msg.type ) {
		case MSG.GET_STATE:
			return {
				enabled: await store.isEnabled(),
				patches: await store.getPatches()
			};

		case MSG.SET_ENABLED: {
			await store.setEnabled( msg.value );
			if ( !msg.value ) {
				await clearAllDebugCookies();
			}
			return { enabled: await store.isEnabled() };
		}

		case MSG.ADD_PATCH:
			return { payload: await handleAddPatch( msg.input ) };

		case MSG.REMOVE_PATCH:
			return { patches: await store.removePatch( msg.key ) };

		case MSG.SET_PATCH_ENABLED:
			return { patches: await store.updatePatch( msg.key, { enabled: msg.value } ) };

		case MSG.REVIEW_PATCH:
			return { patches: await store.updatePatch( msg.key, { reviewed: msg.value } ) };

		case MSG.REFRESH_PATCH:
			return { payload: await handleRefreshPatch( msg.key ) };

		case MSG.GET_PATCH_PAYLOAD: {
			// Serve the cache. Only read Gerrit again when the cache expired.
			const cached = await store.getCachedPayload( msg.key );
			return { payload: cached || await handleRefreshPatch( msg.key ) };
		}

		case MSG.GET_PAYLOAD: {
			// Only a content script may ask, and only for its own origin.
			if ( !sender.tab || !sender.origin ) {
				throw new Error( 'Refused: no tab origin.' );
			}
			const result = await buildPagePayload( sender.origin );
			if ( result.active ) {
				await enableDebug( sender.origin );
			}
			return result;
		}

		case MSG.REPORT_STATUS:
			if ( sender.tab ) {
				setTabStatus( sender.tab.id, msg.report );
			}
			return { ok: true };

		case MSG.GET_TAB_STATUS:
			return { report: getTabStatus( msg.tabId ) };

		default:
			throw new Error( 'Unknown message type: ' + msg.type );
	}
}

chrome.runtime.onMessage.addListener( ( msg, sender, sendResponse ) => {
	dispatch( msg, sender )
		.then( ( result ) => sendResponse( { ok: true, result } ) )
		.catch( ( err ) => sendResponse( { ok: false, error: String( err && err.message || err ) } ) );
	// Keep the channel open for the async reply.
	return true;
} );

// A crash can leave the debug cookie behind. Clear it whenever we start.
chrome.runtime.onStartup.addListener( () => {
	clearAllDebugCookies();
} );
chrome.runtime.onInstalled.addListener( () => {
	clearAllDebugCookies();
} );

watchTabs();

export { buildPagePayload, disableDebug };
