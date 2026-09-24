/**
 * Follow a stylesheet's @import statements across repositories.
 *
 * ResourceLoader resolves an @import against the active skin's import
 * directory, then core's, with a path map for the Codex packages. None of
 * those files are in the patch, so each one is read from Gerrit.
 *
 * The result is one flat source with every import put in place, which any
 * LESS compiler can take without a custom file loader.
 */

import {
	CORE_PROJECT, LESS_FORBIDDEN_PREFIX, lessSearchDirs, mapLessPrefix,
	joinPath, normalisePath, projectForSkin, deployBranch
} from '../shared/mw-layout.js';
import { readRepoFile, readRepoJson, pickRef } from './repo-files.js';
import { classifyProject } from '../shared/mw-layout.js';

/** Matches an @import, with its options and its path. */
const IMPORT_RE = /@import\s*(\([^)]*\))?\s*(['"])([^'"]+)\2\s*;?/g;

/**
 * Mark which characters are inside a comment.
 *
 * MediaWiki's own LESS files show examples as commented-out @import lines.
 * Treating those as real imports both reports false misses and would paste
 * in a file the author deliberately left out.
 *
 * @param {string} source
 * @return {Uint8Array} 1 where the character is inside a comment.
 */
function commentMask( source ) {
	const mask = new Uint8Array( source.length );
	let state = 'code';
	let quote = '';
	for ( let i = 0; i < source.length; i++ ) {
		const ch = source[ i ];
		const next = source[ i + 1 ];
		if ( state === 'code' ) {
			if ( ch === '/' && next === '*' ) {
				state = 'block';
				mask[ i ] = mask[ i + 1 ] = 1;
				i++;
			} else if ( ch === '/' && next === '/' ) {
				state = 'line';
				mask[ i ] = mask[ i + 1 ] = 1;
				i++;
			} else if ( ch === '"' || ch === "'" ) {
				state = 'string';
				quote = ch;
			}
		} else if ( state === 'block' ) {
			mask[ i ] = 1;
			if ( ch === '*' && next === '/' ) {
				mask[ i + 1 ] = 1;
				i++;
				state = 'code';
			}
		} else if ( state === 'line' ) {
			if ( ch === '\n' ) {
				state = 'code';
			} else {
				mask[ i ] = 1;
			}
		} else if ( state === 'string' ) {
			if ( ch === '\\' ) {
				i++;
			} else if ( ch === quote ) {
				state = 'code';
			}
		}
	}
	return mask;
}

/** A file we are resolving, identified by repository and path. */
function fileId( project, path ) {
	return `${ project }:${ path }`;
}

function dirOf( path ) {
	const i = path.lastIndexOf( '/' );
	return i === -1 ? '' : path.slice( 0, i );
}

/**
 * Work out where the wiki keeps the skin's LESS directory.
 *
 * The directory is not fixed: each skin declares it as SkinLessImportPaths
 * in its own manifest. So read the manifest rather than copy the value.
 *
 * @param {string} skinKey
 * @param {string|null} version wgVersion, used to pick the deployed branch.
 * @param {Object} [io] Replaces the Gerrit reader, for tests.
 * @return {Promise<{ project: string|null, path: string|null, ref: string }>}
 */
export async function findSkinImportPath( skinKey, version, io ) {
	const readJson = ( io && io.readRepoJson ) || readRepoJson;
	const choose = ( io && io.pickRef ) || pickRef;
	const project = projectForSkin( skinKey );
	if ( !project || project === CORE_PROJECT ) {
		return { project: null, path: null, ref: 'master' };
	}
	const ref = await choose( project, [ deployBranch( version ), 'master' ] );
	const info = classifyProject( project );
	const manifest = await readJson(
		project, ref, info.type === 'skin' ? 'skin.json' : 'extension.json'
	);
	const paths = manifest && manifest.SkinLessImportPaths;
	return { project, path: ( paths && paths[ skinKey ] ) || null, ref };
}

/**
 * Find the file an @import points at.
 *
 * @param {string} spec The path as written in the @import.
 * @param {{ project: string, path: string }} from The importing file.
 * @param {Array<{ project: string, dir: string, ref: string }>} searchDirs
 * @param {Object<string,string>} refs Project to ref.
 * @return {Promise<{ project: string, path: string, source: string }|null>}
 */
async function locate( spec, from, searchDirs, refs, io ) {
	/** Try one place, with and without the .less suffix. */
	const tryAt = async ( project, path, ref ) => {
		for ( const candidate of ( /\.(less|css)$/.test( path ) ?
			[ path ] : [ path, path + '.less' ] ) ) {
			const clean = normalisePath( candidate );
			const source = await io.readRepoFile( project, ref, clean );
			if ( source !== null ) {
				return { project, path: clean, source };
			}
		}
		return null;
	};

	// 1. The Codex path map wins, because those names are not real paths.
	const mapped = mapLessPrefix( spec );
	if ( mapped ) {
		return tryAt( mapped.project, mapped.path, refs[ CORE_PROJECT ] );
	}

	// 2. Beside the importing file, in its own repository.
	const beside = await tryAt(
		from.project, joinPath( dirOf( from.path ), spec ), refs[ from.project ]
	);
	if ( beside ) {
		return beside;
	}

	// 3. The skin's directory, then core's.
	for ( const dir of searchDirs ) {
		const hit = await tryAt( dir.project, joinPath( dir.dir, spec ), dir.ref );
		if ( hit ) {
			return hit;
		}
	}
	return null;
}

/**
 * Put every imported file in place, so one string holds the whole
 * stylesheet.
 *
 * LESS imports a file once by default, so a repeated import is dropped
 * rather than repeated.
 *
 * @param {Object} opts
 * @param {string} opts.source The patch stylesheet.
 * @param {string} opts.path Its path in the patch repository.
 * @param {string} opts.project The patch repository.
 * @param {string} opts.ref The patch revision.
 * @param {string} opts.skinKey Active skin, from mw.config.
 * @param {string|null} opts.version wgVersion, for the deployed branch.
 * @param {Object} [opts.io] Replaces the Gerrit reader, for tests.
 * @return {Promise<{ source: string, files: string[], missing: string[],
 *                    errors: string[] }>}
 */
export async function flattenStyle( opts ) {
	const io = opts.io || { readRepoFile, readRepoJson, pickRef };
	const coreRef = await io.pickRef( CORE_PROJECT, [ deployBranch( opts.version ), 'master' ] );
	const skin = await findSkinImportPath( opts.skinKey, opts.version, io );
	const searchDirs = lessSearchDirs( {
		skinProject: skin.project,
		skinImportPath: skin.path,
		skinRef: skin.ref,
		coreRef
	} );

	const refs = { [ CORE_PROJECT ]: coreRef, [ opts.project ]: opts.ref };
	if ( skin.project ) {
		refs[ skin.project ] = skin.ref;
	}

	const seen = new Set();
	const files = [];
	const missing = new Set();
	const errors = [];

	/**
	 * Replace every @import in one file, depth first.
	 *
	 * @param {string} source
	 * @param {{ project: string, path: string }} from
	 * @return {Promise<string>}
	 */
	async function expand( source, from ) {
		const out = [];
		const mask = commentMask( source );
		let last = 0;
		IMPORT_RE.lastIndex = 0;
		let m;
		while ( ( m = IMPORT_RE.exec( source ) ) !== null ) {
			if ( mask[ m.index ] ) {
				// A commented-out example, not a real import.
				continue;
			}
			out.push( source.slice( last, m.index ) );
			last = m.index + m[ 0 ].length;

			const options = m[ 1 ] || '';
			const spec = m[ 3 ];

			if ( spec.startsWith( LESS_FORBIDDEN_PREFIX ) ) {
				errors.push(
					`${ from.path }: MediaWiki refuses "@import '${ spec }'". ` +
					"Use @import 'mediawiki.skin.variables.less' instead."
				);
				continue;
			}
			// A CSS import stays a real import; the browser fetches it.
			if ( options.includes( 'css' ) || /^https?:\/\//.test( spec ) ) {
				out.push( m[ 0 ] );
				continue;
			}

			const hit = await locate( spec, from, searchDirs, refs, io );
			if ( !hit ) {
				missing.add( `${ from.path }: cannot find "${ spec }"` );
				continue;
			}
			const id = fileId( hit.project, hit.path );
			if ( seen.has( id ) ) {
				// LESS imports each file once, so a repeat adds nothing.
				continue;
			}
			seen.add( id );
			files.push( id );
			refs[ hit.project ] = refs[ hit.project ] || 'master';

			out.push( `/* < ${ id } */\n` );
			out.push( await expand( hit.source, hit ) );
			out.push( `\n/* > ${ id } */\n` );
		}
		out.push( source.slice( last ) );
		return out.join( '' );
	}

	const entry = { project: opts.project, path: opts.path };
	seen.add( fileId( entry.project, entry.path ) );
	const source = await expand( opts.source, entry );

	return { source, files, missing: [ ...missing ], errors };
}
