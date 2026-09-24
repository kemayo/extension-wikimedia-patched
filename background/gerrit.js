/**
 * Anonymous Gerrit REST client.
 *
 * All requests use credentials: 'omit'. The extension must not become a
 * signed-in proxy for a hostile page.
 */

import { GERRIT_BASE } from '../shared/constants.js';

/** Gerrit puts this prefix on JSON bodies to break naive script includes. */
const XSSI_PREFIX = ")]}'";

class GerritError extends Error {
	constructor( message, status ) {
		super( message );
		this.name = 'GerritError';
		this.status = status;
	}
}

/**
 * Read a change number or Change-Id out of user input.
 *
 * Accepts a bare number, a Change-Id, or any of the Gerrit URL shapes.
 * Returns null if nothing valid is found. The caller must treat a null as
 * bad input; never pass raw user text into a request path.
 *
 * @param {string} input
 * @return {{ type: 'number'|'changeid', id: string, patchset: number|null }|null}
 */
export function parsePatchRef( input ) {
	const text = String( input || '' ).trim();
	if ( !text ) {
		return null;
	}

	// Bare change number, with an optional patchset: "1321624" or "1321624/17".
	let m = /^([0-9]+)(?:\/([0-9]+))?$/.exec( text );
	if ( m ) {
		return { type: 'number', id: m[ 1 ], patchset: m[ 2 ] ? Number( m[ 2 ] ) : null };
	}

	// Bare Change-Id.
	m = /^(I[0-9a-f]{40})$/i.exec( text );
	if ( m ) {
		return { type: 'changeid', id: m[ 1 ], patchset: null };
	}

	// Any gerrit.wikimedia.org URL. Reject other hosts.
	let url;
	try {
		url = new URL( text );
	} catch ( e ) {
		return null;
	}
	if ( url.hostname !== 'gerrit.wikimedia.org' ) {
		return null;
	}

	// Modern:  /r/c/<project>/+/<number>[/<patchset>]
	// Legacy:  /r/#/c/<number>[/<patchset>]  and  /r/<number>
	const path = url.pathname + url.hash;
	m = /\/\+\/([0-9]+)(?:\/([0-9]+))?/.exec( path ) ||
		/\/c\/([0-9]+)(?:\/([0-9]+))?/.exec( path ) ||
		/^\/r\/([0-9]+)\/?$/.exec( url.pathname );
	if ( m ) {
		return { type: 'number', id: m[ 1 ], patchset: m[ 2 ] ? Number( m[ 2 ] ) : null };
	}

	m = /(I[0-9a-f]{40})/i.exec( path );
	if ( m ) {
		return { type: 'changeid', id: m[ 1 ], patchset: null };
	}

	return null;
}

/**
 * Build a Gerrit URL from parts that are already validated.
 *
 * @param {string[]} segments Path segments. Each one is encoded.
 * @param {Object} [query]
 * @return {string}
 */
function buildUrl( segments, query ) {
	const path = segments.map( ( s ) => encodeURIComponent( s ) ).join( '/' );
	const qs = query ? '?' + new URLSearchParams( query ).toString() : '';
	return `${ GERRIT_BASE }/${ path }${ qs }`;
}

async function request( url, { json = true } = {} ) {
	const res = await fetch( url, {
		credentials: 'omit',
		redirect: 'follow',
		headers: { Accept: json ? 'application/json' : 'text/plain' }
	} );
	if ( !res.ok ) {
		throw new GerritError( `Gerrit returned ${ res.status } for ${ url }`, res.status );
	}
	const body = await res.text();
	if ( !json ) {
		return body;
	}
	// Remove the XSSI prefix before parsing.
	const start = body.indexOf( XSSI_PREFIX );
	return JSON.parse( start === 0 ? body.slice( XSSI_PREFIX.length ) : body );
}

/**
 * Turn a parsed reference into a numeric change id.
 *
 * A Change-Id can match more than one change, so query instead of guessing.
 *
 * @param {ReturnType<parsePatchRef>} ref
 * @return {Promise<string>} The change number.
 */
export async function resolveChangeNumber( ref ) {
	if ( ref.type === 'number' ) {
		return ref.id;
	}
	const results = await request(
		buildUrl( [ 'changes', '' ], { q: `change:${ ref.id }`, n: '5' } )
	);
	if ( !results.length ) {
		throw new GerritError( `No change matches ${ ref.id }`, 404 );
	}
	// A Change-Id is shared by a change and its backports. Mean the one on
	// master, and only give up if that is still not one change.
	const onMaster = results.filter( ( c ) => c.branch === 'master' );
	const pool = onMaster.length ? onMaster : results;
	if ( pool.length > 1 ) {
		throw new GerritError(
			`${ ref.id } matches ${ pool.length } changes. Use the change number instead.`, 409
		);
	}
	return String( pool[ 0 ]._number );
}

/**
 * Get the change, with every revision.
 *
 * @param {string} changeNumber
 * @return {Promise<Object>} Gerrit ChangeInfo.
 */
export async function getChange( changeNumber ) {
	const url = buildUrl( [ 'changes', changeNumber ] ) +
		'?o=ALL_REVISIONS&o=ALL_COMMITS&o=DETAILED_ACCOUNTS';
	return request( url );
}

/**
 * Find the revision SHA for a patchset number.
 *
 * @param {Object} change ChangeInfo with a revisions map.
 * @param {number|null} patchset Null means the current patchset.
 * @return {{ sha: string, number: number }}
 */
export function pickRevision( change, patchset ) {
	const entries = Object.entries( change.revisions || {} );
	if ( !entries.length ) {
		throw new GerritError( 'Change has no revisions', 404 );
	}
	if ( patchset === null || patchset === undefined ) {
		const sha = change.current_revision || entries[ entries.length - 1 ][ 0 ];
		return { sha, number: change.revisions[ sha ]._number };
	}
	const hit = entries.find( ( [ , info ] ) => info._number === Number( patchset ) );
	if ( !hit ) {
		throw new GerritError( `Change has no patchset ${ patchset }`, 404 );
	}
	return { sha: hit[ 0 ], number: hit[ 1 ]._number };
}

/**
 * List the files that a revision changes.
 *
 * Gerrit adds pseudo-entries such as /COMMIT_MSG. They are dropped here.
 *
 * @param {string} changeNumber
 * @param {string} revision SHA or patchset number.
 * @return {Promise<Object<string,Object>>} Path to Gerrit FileInfo.
 */
export async function listFiles( changeNumber, revision ) {
	const raw = await request(
		buildUrl( [ 'changes', changeNumber, 'revisions', revision, 'files', '' ] )
	);
	const out = {};
	for ( const [ path, info ] of Object.entries( raw ) ) {
		if ( !path.startsWith( '/' ) ) {
			out[ path ] = info;
		}
	}
	return out;
}

/**
 * Read one file at a revision.
 *
 * @param {string} changeNumber
 * @param {string} revision
 * @param {string} filePath Repository path.
 * @param {Object} [opts]
 * @param {boolean} [opts.parent] Read the parent commit instead.
 * @return {Promise<string|null>} File text, or null if the file is absent.
 */
export async function getFileContent( changeNumber, revision, filePath, opts = {} ) {
	const url = buildUrl(
		[ 'changes', changeNumber, 'revisions', revision, 'files', filePath, 'content' ],
		opts.parent ? { parent: '1' } : null
	);
	let base64;
	try {
		base64 = await request( url, { json: false } );
	} catch ( e ) {
		// A new file has no parent content, and a deleted file has no content.
		if ( e.status === 404 ) {
			return null;
		}
		throw e;
	}
	return decodeBase64Utf8( base64 );
}

/**
 * Decode base64 into a UTF-8 string.
 *
 * atob gives one byte per code unit, so the bytes must be re-decoded.
 *
 * @param {string} base64
 * @return {string}
 */
export function decodeBase64Utf8( base64 ) {
	const binary = atob( String( base64 ).replace( /\s+/g, '' ) );
	const bytes = new Uint8Array( binary.length );
	for ( let i = 0; i < binary.length; i++ ) {
		bytes[ i ] = binary.charCodeAt( i );
	}
	return new TextDecoder( 'utf-8' ).decode( bytes );
}

/**
 * Read any Gerrit REST path that is already built from validated parts.
 *
 * @param {string} path Relative to /r/, with any query string.
 * @return {Promise<*>}
 */
export function gerritGet( path ) {
	return request( `${ GERRIT_BASE }/${ path }` );
}

export { GerritError };
