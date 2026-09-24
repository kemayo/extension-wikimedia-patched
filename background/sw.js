/**
 * Background worker. Routes messages, talks to Gerrit, holds per-tab state.
 *
 * The worker can stop at any time, so all durable state lives in
 * extension storage. Only the per-tab report is in memory, and it is rebuilt on
 * the next page load.
 */

import { ext } from '../shared/webext.js';
import {
	BUILD_ID, MSG, DEV_WIKI_MATCHES, PROD_WIKI_MATCHES, NON_WIKI_MATCHES
} from '../shared/constants.js';
import { parsePatchRef } from './gerrit.js';
import { preparePatch } from './prepare.js';
import { flattenStyle } from './less-resolve.js';
import { rememberVersion, versionFor, withDeployed, withBudget } from './deployed.js';
import { compileLess } from '../shared/less-compile.js';
import * as store from './store.js';
import {
	enableDebug, disableDebug, clearAllDebugCookies,
	enableDebugForTab, disableDebugForTab, installFirefoxRewrite
} from './debug-mode.js';
import { setTabStatus, getTabStatus, watchTabs, paintBadge } from './tab-state.js';
import { badgeFor } from './badge.js';
import { stackOrder, dependencyReport } from '../shared/stack-order.js';
import { deployedOn, undeployedBase } from './deps.js';
import { branchExists } from './repo-files.js';
import { deployBranch } from '../shared/mw-layout.js';
import { mayHandle, senderOrigin } from './sender-policy.js';

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
		parentSha: payload.parentSha,
		changeId: payload.changeId,
		deps: payload.deps,
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
	// A chain or a Depends-On footer can change when the patch is read again.
	await store.updatePatch( key, {
		parentSha: payload.parentSha, changeId: payload.changeId, deps: payload.deps
	} );
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

	const ready = ( await store.getPatches() ).filter( ( p ) => p.enabled && p.reviewed );
	// A patch built on another must run after it, or its merge reads the
	// other patch's changes as conflicts.
	const { order } = stackOrder( ready );
	const patches = order.map( ( key ) => ready.find( ( p ) => p.key === key ) );
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

/**
 * Say why a tab is or is not being patched.
 *
 * Without this the popup can only show per-file results, and a page that
 * never ran looks the same as a page where nothing matched. Those need
 * different answers from the user, so they must look different.
 *
 * @param {number} tabId
 * @return {Promise<Object>}
 */
async function diagnose( tabId ) {
	let tab = null;
	try {
		tab = await ext.tabs.get( tabId );
	} catch ( e ) {
		return { reason: 'no-tab' };
	}
	let origin = null;
	try {
		origin = new URL( tab.url ).origin;
	} catch ( e ) {
		return { reason: 'not-a-wiki', url: tab.url || null };
	}

	const siteKind = classifyOrigin( origin );
	let hasPermission = true;
	try {
		hasPermission = await ext.permissions.contains( { origins: [ origin + '/*' ] } );
	} catch ( e ) {
		// Older browsers may refuse the check; assume it is granted.
	}

	const patches = await store.getPatches();
	return {
		origin,
		siteKind,
		hasPermission,
		enabled: await store.isEnabled(),
		patchCount: patches.length,
		readyPatchCount: patches.filter( ( p ) => p.enabled && p.reviewed ).length,
		unreviewedCount: patches.filter( ( p ) => !p.reviewed ).length,
		acknowledged: siteKind === 'prod' ? await store.hasProductionAck( origin ) : true,
		reason: null,
		report: getTabStatus( tabId )
	};
}

/**
 * Repaint one tab's badge from what is known about it now.
 *
 * @param {number} tabId
 */
async function refreshBadge( tabId ) {
	try {
		paintBadge( tabId, badgeFor( await diagnose( tabId ) ) );
	} catch ( e ) {
		// The tab may have closed.
	}
}

/** Repaint every tab, after a change that can affect them all. */
async function refreshAllBadges() {
	const tabs = await ext.tabs.query( {} ).catch( () => [] );
	await Promise.all( tabs.map( ( tab ) => refreshBadge( tab.id ) ) );
}

/**
 * Read the deployed copies for every active patch, to fill the cache.
 *
 * @param {string} version
 */
async function warmDeployed( version ) {
	const patches = ( await store.getPatches() ).filter( ( p ) => p.enabled && p.reviewed );
	await Promise.all( patches.map( async ( patch ) => {
		const payload = await store.getCachedPayload( patch.key );
		if ( payload ) {
			await withDeployed( payload, version );
		}
	} ) );
}

/**
 * Check every patch's needs against the wiki in one tab.
 *
 * Merged is not the same as deployed, so every merged dependency, and the
 * merged history under each patch, is checked against the branch that
 * wiki runs. This reads Gerrit and Gitiles, so the popup asks for it after
 * it has drawn the list, and never the page.
 *
 * @param {number} tabId
 * @return {Promise<Object>}
 */
async function checkStack( tabId ) {
	let origin = null;
	try {
		origin = new URL( ( await ext.tabs.get( tabId ) ).url ).origin;
	} catch ( e ) {}
	const version = origin && versionFor( origin );
	const branch = deployBranch( version );
	const patches = await store.getPatches();
	const perPatch = {};

	await Promise.all( patches.map( async ( patch ) => {
		const merged = [
			...( ( patch.deps && patch.deps.ancestors ) || [] ),
			...( ( patch.deps && patch.deps.dependsOn ) || [] )
		].filter( ( d ) => d.status === 'MERGED' && d.changeNumber );
		const deployed = {};
		if ( branch ) {
			await Promise.all( merged.map( async ( d ) => {
				deployed[ d.changeNumber ] = await deployedOn(
					{ changeNumber: d.changeNumber, changeId: d.changeId,
						project: d.project || patch.project }, branch );
			} ) );
		}

		let base = null;
		if ( branch && patch.parentSha && await branchExists( patch.project, branch ) ) {
			const range = await undeployedBase( patch.project, patch.parentSha, branch );
			base = range ? {
				count: range.commits.length, more: range.more,
				commits: range.commits.slice( 0, 50 )
			} : { unavailable: true };
		}
		perPatch[ patch.key ] = { deps: dependencyReport( patch, patches, deployed ), base };
	} ) );

	return { origin, version, branch, perPatch };
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

/**
 * Show the switch in the icon itself: grey when off.
 *
 * The badge says what happened on one tab; the icon says whether the
 * extension is doing anything at all. It is set for every tab at once.
 */
async function applyIcon() {
	const on = await store.isEnabled();
	const name = on ? 'icon' : 'icon-off';
	await ext.action.setIcon( {
		path: { 16: `icons/${ name }-16.png`, 32: `icons/${ name }-32.png` }
	} ).catch( () => {} );
}

/** Messages after which every badge may be out of date. */
const CHANGES_BADGES = new Set( [
	MSG.SET_ENABLED, MSG.ADD_PATCH, MSG.REMOVE_PATCH, MSG.SET_PATCH_ENABLED,
	MSG.REVIEW_PATCH, MSG.ACK_SITE, MSG.ACK_ELEVATED
] );

/** Handle one message. Split out so the listener can stay small. */
async function dispatch( msg, sender ) {
	switch ( msg.type ) {
		case MSG.GET_STATE: {
			return {
				enabled: await store.isEnabled(),
				patches: await store.getPatches(),
				buildId: BUILD_ID
			};
		}

		case MSG.GET_STACK_CHECK:
			return await checkStack( msg.tabId );

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
			const origin = senderOrigin( sender );
			if ( !sender.tab || !origin ) {
				throw new Error( 'Refused: no tab origin.' );
			}
			const result = await buildPagePayload( origin );
			if ( result.active ) {
				// The wiki's own copy of each changed file, so the page can
				// merge instead of replacing. Usually cached from the last
				// visit; never allowed to delay the page for long.
				const version = versionFor( origin );
				if ( version ) {
					const enriched = await withBudget( Promise.all(
						result.patches.map( ( p ) => withDeployed( p, version ) )
					), 400 );
					if ( enriched ) {
						result.patches = enriched;
					}
				}
				const settings = await store.getSettings();
				if ( settings.debugStrategy === 'cookie' ) {
					await enableDebug( origin );
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
				refreshBadge( sender.tab.id );
			}
			if ( msg.report && msg.report.version && senderOrigin( sender ) ) {
				rememberVersion( senderOrigin( sender ), msg.report.version );
				// Fetch the deployed files now, off the page's critical path,
				// so the next load finds them cached.
				warmDeployed( msg.report.version ).catch( () => {} );
			}
			return { ok: true };

		case MSG.GET_TAB_STATUS:
			return { report: getTabStatus( msg.tabId ) };

		case MSG.ACK_ELEVATED:
			if ( !classifyOrigin( msg.origin ) ) {
				throw new Error( 'Refused: not a wiki.' );
			}
			await store.ackElevated( msg.origin );
			return { ok: true };

		case MSG.GET_STYLES: {
			if ( !sender.tab || !classifyOrigin( senderOrigin( sender ) ) ) {
				throw new Error( 'Refused: not a wiki.' );
			}
			return { styles: await buildStyles( msg.skinKey, msg.version ) };
		}

		case MSG.ACK_SITE:
			// The popup has already asked the browser for the host
			// permission. This records that the user accepted the risk.
			if ( !classifyOrigin( msg.origin ) ) {
				throw new Error( 'Refused: not a wiki.' );
			}
			await store.ackProduction( msg.origin );
			return { ok: true };

		case MSG.GET_DIAGNOSIS:
			return { diagnosis: await diagnose( msg.tabId ) };

		case MSG.GET_SETTINGS:
			return { settings: await store.getSettings() };

		case MSG.SET_SETTING:
			return { settings: await store.setSetting( msg.key, msg.value ) };

		default:
			throw new Error( 'Unknown message type: ' + msg.type );
	}
}

ext.runtime.onMessage.addListener( ( msg, sender, sendResponse ) => {
	if ( !msg || !mayHandle( msg.type, sender, ext.runtime.getURL( '' ) ) ) {
		// A page asked for something only the extension's own pages may do.
		sendResponse( { ok: false, error: 'Refused: not allowed from a web page.' } );
		return false;
	}
	dispatch( msg, sender )
		.then( ( result ) => {
			// A change to the switch, a site's confirmation or the patch
			// list can change what every tab's badge should say.
			if ( CHANGES_BADGES.has( msg.type ) ) {
				refreshAllBadges();
			}
			if ( msg.type === MSG.SET_ENABLED ) {
				applyIcon();
			}
			return result;
		} )
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

watchTabs( refreshBadge );
// The worker restarts often, so set the icon each time it starts.
applyIcon();

export { buildPagePayload, disableDebug };
