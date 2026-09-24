/**
 * Read any file from any Gerrit project, at any branch or commit.
 *
 * The change API only serves files a change touches. Resolving an @import,
 * or comparing against the code a wiki really runs, needs the rest of the
 * repository too.
 *
 * This uses the Gerrit REST API, not Gitiles. Gitiles is rate limited hard
 * and answers 429 under any real use.
 */

import { GERRIT_BASE } from '../shared/constants.js';
import { decodeBase64Utf8 } from './gerrit.js';

/**
 * A file at a commit never changes, so that answer is kept for good. A
 * branch moves, most often when a fix is backported to a wmf branch, so a
 * branch answer is kept only for a while.
 */
const cache = new Map();
const BRANCH_TTL_MS = 10 * 60 * 1000;

function cacheGet( key, ref ) {
	const hit = cache.get( key );
	if ( !hit ) {
		return undefined;
	}
	if ( !isCommit( ref ) && Date.now() - hit.at > BRANCH_TTL_MS ) {
		cache.delete( key );
		return undefined;
	}
	return hit.value;
}

function cacheSet( key, value ) {
	cache.set( key, { value, at: Date.now() } );
}
const RETRY_DELAYS_MS = [ 300, 900 ];

const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

/** A 40-character hex string is a commit; anything else is a branch. */
function isCommit( ref ) {
	return /^[0-9a-f]{40}$/i.test( ref );
}

/**
 * Read one file.
 *
 * @param {string} project Gerrit project, such as "mediawiki/core".
 * @param {string} ref Branch name or commit SHA.
 * @param {string} path Path inside the repository.
 * @return {Promise<string|null>} Null when the file is not there.
 */
export async function readRepoFile( project, ref, path ) {
	const key = `${ project }\u0000${ ref }\u0000${ path }`;
	const cached = cacheGet( key, ref );
	if ( cached !== undefined ) {
		return cached;
	}

	const kind = isCommit( ref ) ? 'commits' : 'branches';
	const url = `${ GERRIT_BASE }/projects/${ encodeURIComponent( project ) }/` +
		`${ kind }/${ encodeURIComponent( ref ) }/files/` +
		`${ encodeURIComponent( path ) }/content`;

	for ( let attempt = 0; ; attempt++ ) {
		let res;
		try {
			res = await fetch( url, { credentials: 'omit' } );
		} catch ( e ) {
			return null;
		}
		if ( res.status === 404 ) {
			cacheSet( key, null );
			return null;
		}
		if ( ( res.status === 429 || res.status === 503 ) &&
			attempt < RETRY_DELAYS_MS.length ) {
			await sleep( RETRY_DELAYS_MS[ attempt ] );
			continue;
		}
		if ( !res.ok ) {
			return null;
		}
		const text = decodeBase64Utf8( await res.text() );
		cacheSet( key, text );
		return text;
	}
}

/**
 * Read a JSON file, such as an extension.json or a skin.json.
 *
 * @param {string} project
 * @param {string} ref
 * @param {string} path
 * @return {Promise<Object|null>}
 */
export async function readRepoJson( project, ref, path ) {
	const text = await readRepoFile( project, ref, path );
	if ( text === null ) {
		return null;
	}
	try {
		return JSON.parse( text.replace( /^\uFEFF/, '' ) );
	} catch ( e ) {
		return null;
	}
}

/**
 * Find a branch that exists, preferring the first.
 *
 * A wiki on a wmf branch is the normal case, but a patch may be newer than
 * any deployed branch, and a local wiki has no wmf branch at all.
 *
 * @param {string} project
 * @param {Array<string|null>} refs
 * @return {Promise<string>} The first usable ref, or "master".
 */
export async function pickRef( project, refs ) {
	for ( const ref of refs ) {
		if ( !ref ) {
			continue;
		}
		if ( await branchExists( project, ref ) ) {
			return ref;
		}
	}
	return 'master';
}

/**
 * Say whether a branch exists. Cached like a branch file.
 *
 * @param {string} project
 * @param {string} ref
 * @return {Promise<boolean>}
 */
export async function branchExists( project, ref ) {
	if ( ref === 'master' ) {
		return true;
	}
	const key = `branch\u0000${ project }\u0000${ ref }`;
	const cached = cacheGet( key, ref );
	if ( cached !== undefined ) {
		return cached;
	}
	{
		const url = `${ GERRIT_BASE }/projects/${ encodeURIComponent( project ) }/` +
			`branches/${ encodeURIComponent( ref ) }`;
		try {
			const res = await fetch( url, { credentials: 'omit' } );
			// Only a clear answer is cached. A network failure is not "no".
			if ( res.ok || res.status === 404 ) {
				cacheSet( key, res.ok );
			}
			return res.ok;
		} catch ( e ) {
			return false;
		}
	}
}
