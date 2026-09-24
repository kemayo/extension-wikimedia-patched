/**
 * Background worker. Routes messages, talks to Gerrit, holds per-tab state.
 *
 * The worker can stop at any time, so all durable state lives in
 * extension storage. Only the per-tab report is in memory, and it is rebuilt on
 * the next page load.
 */

import { ext } from '../shared/webext.js';
import {
	MSG, DEV_WIKI_MATCHES, PROD_WIKI_MATCHES, NON_WIKI_MATCHES
} from '../shared/constants.js';
import { parsePatchRef } from './gerrit.js';
import { preparePatch } from './prepare.js';
import { flattenStyle } from './less-resolve.js';
import { compileLess } from '../shared/less-compile.js';
import * as store from './store.js';
import {
	enableDebug, disableDebug, clearAllDebugCookies,
	enableDebugForTab, disableDebugForTab, installFirefoxRewrite
} from './debug-mode.js';
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
	return {
		active: payloads.length > 0,
		reason: null,
		siteKind: kind,
		elevatedAck: await store.hasElevatedAck( origin ),
		patches: payloads
	};
}

/** Compiled stylesheets, keyed by patch, skin and wiki version. */
const styleCache = new Map();

/**
 * Compile every stylesheet that needed the skin.
 *
 * A patch stylesheet imports mediawiki.skin.variables.less, which resolves
 * to a different file per skin, in a different repository. So the work
 * cannot happen until the page says which skin it uses.
 *
 * @param {string} skinKey
 * @param {string|null} version
 * @return {Promise<Array<{ patchKey: string, path: string, css: string|null,
 *                          reason: string|null }>>}
 */
async function buildStyles( skinKey, version ) {
	const patches = ( await store.getPatches() ).filter( ( p ) => p.enabled && p.reviewed );
	const out = [];

	for ( const patch of patches ) {
		const payload = await store.getCachedPayload( patch.key );
		for ( const style of ( payload && payload.pendingStyles ) || [] ) {
			const key = `${ patch.key }|${ skinKey }|${ version }|${ style.path }`;
			if ( styleCache.has( key ) ) {
				out.push( styleCache.get( key ) );
				continue;
			}
			const flat = await flattenStyle( {
				source: style.source,
				path: style.path,
				project: payload.project,
				ref: payload.sha,
				skinKey,
				version
			} );
			let entry;
			if ( flat.errors.length || flat.missing.length ) {
				entry = {
					patchKey: patch.key, path: style.path, css: null,
					reason: [ ...flat.errors, ...flat.missing ].join( '; ' )
				};
			} else {
				const compiled = await compileLess( flat.source, { filename: style.path } );
				entry = {
					patchKey: patch.key, path: style.path,
					css: compiled.ok ? compiled.css : null,
					reason: compiled.reason
				};
			}
			styleCache.set( key, entry );
			out.push( entry );
		}
	}
	return out;
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
				const settings = await store.getSettings();
				if ( settings.debugStrategy === 'cookie' ) {
					await enableDebug( sender.origin );
				}
				// The request strategy arms the tab on navigation instead,
				// because the startup script is requested before a content
				// script can ask for anything.
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

		case MSG.ACK_ELEVATED:
			await store.ackElevated( msg.origin );
			return { ok: true };

		case MSG.GET_STYLES: {
			if ( !sender.tab || !sender.origin ||
				!classifyOrigin( sender.origin ) ) {
				throw new Error( 'Refused: not a wiki.' );
			}
			return { styles: await buildStyles( msg.skinKey, msg.version ) };
		}

		case MSG.GET_SETTINGS:
			return { settings: await store.getSettings() };

		case MSG.SET_SETTING:
			return { settings: await store.setSetting( msg.key, msg.value ) };

		default:
			throw new Error( 'Unknown message type: ' + msg.type );
	}
}

ext.runtime.onMessage.addListener( ( msg, sender, sendResponse ) => {
	dispatch( msg, sender )
		.then( ( result ) => sendResponse( { ok: true, result } ) )
		.catch( ( err ) => sendResponse( { ok: false, error: String( err && err.message || err ) } ) );
	// Keep the channel open for the async reply.
	return true;
} );

// A crash can leave the debug cookie behind. Clear it whenever we start.
ext.runtime.onStartup.addListener( () => {
	clearAllDebugCookies();
} );
ext.runtime.onInstalled.addListener( () => {
	clearAllDebugCookies();
} );

/**
 * Arm a tab before it loads, when the user chose the request strategy.
 *
 * The startup module is requested before any content script runs, so the
 * rule has to be in place at navigation time.
 */
const armedTabs = new Set();

if ( ext.webNavigation && ext.webNavigation.onBeforeNavigate ) {
	ext.webNavigation.onBeforeNavigate.addListener( async ( details ) => {
		if ( details.frameId !== 0 ) {
			return;
		}
		const origin = originOf( details.url );
		const wanted = origin && classifyOrigin( origin ) &&
			await store.isEnabled() &&
			( await store.getSettings() ).debugStrategy === 'request';

		if ( wanted ) {
			armedTabs.add( details.tabId );
			await enableDebugForTab( details.tabId );
		} else if ( armedTabs.has( details.tabId ) ) {
			armedTabs.delete( details.tabId );
			await disableDebugForTab( details.tabId );
		}
	} );
}

function originOf( url ) {
	try {
		return new URL( url ).origin;
	} catch ( e ) {
		return null;
	}
}

// Firefox has no query transform in declarativeNetRequest, so it redirects.
installFirefoxRewrite( ( tabId ) => armedTabs.has( tabId ) );

ext.tabs.onRemoved.addListener( ( tabId ) => {
	armedTabs.delete( tabId );
	disableDebugForTab( tabId );
} );

watchTabs();

export { buildPagePayload, disableDebug };
