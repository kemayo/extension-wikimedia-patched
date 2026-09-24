/**
 * Read a repository tree from Gitiles.
 *
 * Gerrit's change API lists only the files a change touches. To place a new
 * file in the correct ResourceLoader module, the extension also needs the
 * names of the file's siblings.
 */

import { GERRIT_ORIGIN } from '../shared/constants.js';

const XSSI_PREFIX = ")]}'";

/**
 * Gitiles is expensive, so Wikimedia limits it hard and answers 429 often.
 * A tree at a commit never changes, so cache every answer and retry a few
 * times before giving up.
 */
const cache = new Map();
const RETRY_DELAYS_MS = [ 400, 1200, 3000 ];

const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

/**
 * List the file names in one directory of a repository.
 *
 * @param {string} project Gerrit project, such as "mediawiki/core".
 * @param {string} ref Commit SHA or branch.
 * @param {string} dir Directory path. An empty string means the root.
 * @return {Promise<string[]|null>} File names, without directories. Null when
 *   the listing could not be read, which is not the same as an empty
 *   directory.
 */
export async function listDirectory( project, ref, dir ) {
	const cacheKey = `${ project }\u0000${ ref }\u0000${ dir }`;
	if ( cache.has( cacheKey ) ) {
		return cache.get( cacheKey );
	}

	// Gitiles needs a literal "+" between the repository and the revision, so
	// the segments are encoded and the separator is added after.
	const encode = ( parts ) => parts
		.filter( ( part ) => part !== '' )
		.map( encodeURIComponent )
		.join( '/' );
	const repo = encode( project.split( '/' ) );
	const rest = encode( [ ref, ...dir.split( '/' ) ] );
	const url = `${ GERRIT_ORIGIN }/g/${ repo }/+/${ rest }?format=JSON`;

	for ( let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++ ) {
		let res;
		try {
			res = await fetch( url, { credentials: 'omit' } );
		} catch ( e ) {
			return null;
		}
		if ( res.status === 429 || res.status === 503 ) {
			if ( attempt < RETRY_DELAYS_MS.length ) {
				await sleep( RETRY_DELAYS_MS[ attempt ] );
				continue;
			}
			// Out of retries. Null means "unknown", which is not the same as
			// "the directory is empty".
			return null;
		}
		if ( !res.ok ) {
			return null;
		}
		const names = parseListing( await res.text() );
		if ( names ) {
			cache.set( cacheKey, names );
		}
		return names;
	}
	return null;
}

/**
 * Read a Gitiles tree listing.
 *
 * @param {string} body
 * @return {string[]|null}
 */
function parseListing( body ) {
	try {
		const start = body.indexOf( XSSI_PREFIX );
		const data = JSON.parse( start === 0 ? body.slice( XSSI_PREFIX.length ) : body );
		return ( data.entries || [] )
			.filter( ( entry ) => entry.type === 'blob' )
			.map( ( entry ) => entry.name );
	} catch ( e ) {
		return null;
	}
}

/**
 * Make Gitiles JSON parseable.
 *
 * Gitiles writes commit messages with raw newlines inside the strings,
 * which JSON.parse refuses. Escape a newline only where it is inside a
 * string; between tokens it is plain white space.
 *
 * @param {string} text
 * @return {string}
 */
export function escapeRawNewlines( text ) {
	let out = '';
	let inString = false;
	for ( let i = 0; i < text.length; i++ ) {
		const ch = text[ i ];
		if ( inString ) {
			if ( ch === '\\' ) {
				out += ch + ( text[ i + 1 ] || '' );
				i++;
				continue;
			}
			if ( ch === '"' ) {
				inString = false;
			} else if ( ch === '\n' ) {
				out += '\\n';
				continue;
			} else if ( ch === '\r' ) {
				out += '\\r';
				continue;
			} else if ( ch === '\t' ) {
				out += '\\t';
				continue;
			}
		} else if ( ch === '"' ) {
			inString = true;
		}
		out += ch;
	}
	return out;
}

/**
 * List the commits reachable from one commit but not from a branch.
 *
 * With the wiki's branch and a patch's parent, that is every merged change
 * the patch is built on that the wiki does not have.
 *
 * @param {string} project
 * @param {string} branch Such as "wmf/1.47.0-wmf.20".
 * @param {string} sha
 * @param {number} [limit]
 * @return {Promise<{ commits: Array<{ sha: string, changeId: string|null,
 *   subject: string }>, more: boolean }|null>} Null when Gitiles would not answer.
 */
export async function logRange( project, branch, sha, limit = 100 ) {
	const repo = project.split( '/' ).map( encodeURIComponent ).join( '/' );
	const url = `${ GERRIT_ORIGIN }/g/${ repo }/+log/refs/heads/` +
		`${ branch.split( '/' ).map( encodeURIComponent ).join( '/' ) }..` +
		`${ encodeURIComponent( sha ) }?format=JSON&n=${ limit }`;
	for ( let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++ ) {
		let res;
		try {
			res = await fetch( url, { credentials: 'omit' } );
		} catch ( e ) {
			return null;
		}
		if ( ( res.status === 429 || res.status === 503 ) && attempt < RETRY_DELAYS_MS.length ) {
			await sleep( RETRY_DELAYS_MS[ attempt ] );
			continue;
		}
		if ( !res.ok ) {
			return null;
		}
		return parseLog( await res.text() );
	}
	return null;
}

/**
 * Read a Gitiles +log JSON answer.
 *
 * @param {string} body
 * @return {{ commits: Array<{ sha: string, changeId: string|null, subject: string }>,
 *            more: boolean }|null}
 */
export function parseLog( body ) {
	let data;
	try {
		const start = body.indexOf( XSSI_PREFIX );
		data = JSON.parse( escapeRawNewlines(
			start === 0 ? body.slice( XSSI_PREFIX.length ) : body ) );
	} catch ( e ) {
		return null;
	}
	return {
		commits: ( data.log || [] ).map( ( c ) => {
			const id = /^Change-Id: (I[0-9a-f]{40})\s*$/m.exec( c.message || '' );
			return {
				sha: c.commit,
				changeId: id ? id[ 1 ] : null,
				subject: String( c.message || '' ).split( '\n' )[ 0 ]
			};
		} ),
		more: !!data.next
	};
}
