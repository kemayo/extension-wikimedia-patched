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

/** A file at a commit never changes, so every answer is kept. */
const cache = new Map();
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
	if ( cache.has( key ) ) {
		return cache.get( key );
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
			cache.set( key, null );
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
		cache.set( key, text );
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
		return JSON.parse( text.replace( /^﻿/, '' ) );
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
		const url = `${ GERRIT_BASE }/projects/${ encodeURIComponent( project ) }/` +
			`branches/${ encodeURIComponent( ref ) }`;
		try {
			const res = await fetch( url, { credentials: 'omit' } );
			if ( res.ok ) {
				return ref;
			}
		} catch ( e ) {
			// Try the next one.
		}
	}
	return 'master';
}
