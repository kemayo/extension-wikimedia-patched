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
 * List the file names in one directory of a repository.
 *
 * @param {string} project Gerrit project, such as "mediawiki/core".
 * @param {string} ref Commit SHA or branch.
 * @param {string} dir Directory path. An empty string means the root.
 * @return {Promise<string[]>} File names, without directories. Empty on failure.
 */
export async function listDirectory( project, ref, dir ) {
	// Gitiles needs a literal "+" between the repository and the revision, so
	// the segments are encoded and the separator is added after.
	const encode = ( parts ) => parts
		.filter( ( part ) => part !== '' )
		.map( encodeURIComponent )
		.join( '/' );
	const repo = encode( project.split( '/' ) );
	const rest = encode( [ ref, ...dir.split( '/' ) ] );
	const url = `${ GERRIT_ORIGIN }/g/${ repo }/+/${ rest }?format=JSON`;

	let body;
	try {
		const res = await fetch( url, { credentials: 'omit' } );
		if ( !res.ok ) {
			return [];
		}
		body = await res.text();
	} catch ( e ) {
		return [];
	}

	try {
		const start = body.indexOf( XSSI_PREFIX );
		const data = JSON.parse( start === 0 ? body.slice( XSSI_PREFIX.length ) : body );
		return ( data.entries || [] )
			.filter( ( entry ) => entry.type === 'blob' )
			.map( ( entry ) => entry.name );
	} catch ( e ) {
		return [];
	}
}
