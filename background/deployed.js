/**
 * The wiki's own copy of each file a patch changes.
 *
 * A patch is written against master, and a wiki runs a wmf branch cut some
 * days earlier. To apply only the patch's changes, the extension needs the
 * branch's copy of each file as well as the patch's base.
 *
 * In debug mode the page has the exact text already, so this is the
 * fallback for a page that is not in debug mode.
 */

import { deployBranch } from '../shared/mw-layout.js';
import { readRepoFile, branchExists } from './repo-files.js';

/**
 * The version each wiki last reported. A page sends it once mw.config is
 * filled, so the worker never has to ask the wiki itself.
 */
const versions = new Map();
const VERSION_TTL_MS = 60 * 60 * 1000;

export function rememberVersion( origin, version ) {
	if ( origin && version ) {
		versions.set( origin, { version, at: Date.now() } );
	}
}

export function versionFor( origin ) {
	const hit = versions.get( origin );
	if ( !hit || Date.now() - hit.at > VERSION_TTL_MS ) {
		return null;
	}
	return hit.version;
}

/**
 * Add the deployed copy of each changed file to a patch payload.
 *
 * Master is not a fallback. A wiki that is not on a wmf branch has no
 * deployed copy to find, and comparing against master would report skew
 * that the wiki does not have.
 *
 * @param {Object} payload A patch payload. Not changed; a copy comes back.
 * @param {string} version wgVersion of the wiki.
 * @return {Promise<Object>}
 */
export async function withDeployed( payload, version ) {
	const branch = deployBranch( version );
	if ( !branch || !await branchExists( payload.project, branch ) ) {
		return payload;
	}
	const replaceFiles = await Promise.all( payload.replaceFiles.map( async ( file ) => ( {
		...file,
		deployed: {
			ref: branch,
			source: await readRepoFile( payload.project, branch, file.path )
		}
	} ) ) );
	return { ...payload, replaceFiles };
}

/**
 * Wait for a promise, but not for long.
 *
 * This runs while a page is loading. A slow answer must not cost the patch
 * its race against the modules, so past the budget the caller goes without.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @return {Promise<*>} The value, or null if the budget ran out.
 */
export function withBudget( promise, ms ) {
	let timer;
	const timeout = new Promise( ( resolve ) => {
		timer = setTimeout( () => resolve( null ), ms );
	} );
	return Promise.race( [ promise.catch( () => null ), timeout ] )
		.finally( () => clearTimeout( timer ) );
}
