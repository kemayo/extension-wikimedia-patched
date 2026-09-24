/**
 * What MediaWiki looks like, as far as this extension needs to know.
 *
 * A patch names a file by its path inside one repository. To do anything
 * with that file the extension must know which repository it is, where the
 * wiki keeps it, and where an @import inside it points. None of that is in
 * the patch, so it is written down here.
 *
 * Everything is pure and testable. Anything that changes per wiki, such as
 * a skin's own import directory, is read from that skin's manifest at run
 * time instead of being copied here.
 */

export const CORE_PROJECT = 'mediawiki/core';

/**
 * Which repository provides each skin.
 *
 * The skin key and the repository name are often different, so this cannot
 * be worked out from the key alone. Vector ships two skins, MinervaNeue is
 * not called Minerva, and contenttranslation comes from an extension.
 * Keys come from the siteinfo API, so this list is checkable.
 */
export const SKIN_PROJECTS = {
	'vector-2022': 'mediawiki/skins/Vector',
	vector: 'mediawiki/skins/Vector',
	minerva: 'mediawiki/skins/MinervaNeue',
	monobook: 'mediawiki/skins/MonoBook',
	modern: 'mediawiki/skins/Modern',
	cologneblue: 'mediawiki/skins/CologneBlue',
	timeless: 'mediawiki/skins/Timeless',
	nostalgia: 'mediawiki/skins/Nostalgia',
	contenttranslation: 'mediawiki/extensions/ContentTranslation',
	// These live in core and have no separate repository.
	fallback: CORE_PROJECT,
	apioutput: CORE_PROJECT,
	json: CORE_PROJECT,
	'authentication-popup': CORE_PROJECT
};

/**
 * Where ResourceLoader sends an @import whose path starts with one of
 * these. All of them land in core.
 *
 * Source: ResourceLoader::getLessCompiler.
 */
export const LESS_PREFIX_MAP = {
	'mediawiki.skin.codex/': 'resources/lib/codex/',
	'mediawiki.skin.codex-design-tokens/': 'resources/lib/codex-design-tokens/',
	'@wikimedia/codex-icons/': 'resources/lib/codex-icons/'
};

/**
 * An @import starting with this is refused by MediaWiki itself, with advice
 * to use mediawiki.skin.variables.less. Repeat the advice rather than fail
 * with a missing file.
 */
export const LESS_FORBIDDEN_PREFIX = '@wikimedia/codex-design-tokens/';

/** The last place ResourceLoader looks for an @import. Always in core. */
export const CORE_LESS_IMPORT_DIR = 'resources/src/mediawiki.less';

/**
 * Say what a Gerrit project is.
 *
 * @param {string} project
 * @return {{ type: 'core'|'extension'|'skin'|'other', name: string|null,
 *            installPath: string|null }}
 *   installPath is where a wiki puts the repository, relative to $IP.
 */
export function classifyProject( project ) {
	if ( project === CORE_PROJECT ) {
		return { type: 'core', name: 'core', installPath: '' };
	}
	let m = /^mediawiki\/extensions\/([^/]+)$/.exec( project );
	if ( m ) {
		return { type: 'extension', name: m[ 1 ], installPath: `extensions/${ m[ 1 ] }` };
	}
	m = /^mediawiki\/skins\/([^/]+)$/.exec( project );
	if ( m ) {
		return { type: 'skin', name: m[ 1 ], installPath: `skins/${ m[ 1 ] }` };
	}
	return { type: 'other', name: null, installPath: null };
}

/**
 * Turn the version a wiki reports into the branch it runs.
 *
 * mw.config wgVersion gives "1.47.0-wmf.20", and Gerrit calls that branch
 * "wmf/1.47.0-wmf.20". A wiki that is not on a wmf branch, such as a local
 * checkout, gives null and the caller falls back to master.
 *
 * @param {string} version
 * @return {string|null}
 */
export function deployBranch( version ) {
	return /^\d+\.\d+\.\d+-wmf\.\d+$/.test( String( version || '' ) ) ?
		`wmf/${ version }` : null;
}

/**
 * The repository that holds a skin's own LESS import directory.
 *
 * @param {string} skinKey As mw.config skin reports it.
 * @return {string|null}
 */
export function projectForSkin( skinKey ) {
	return SKIN_PROJECTS[ skinKey ] || null;
}

/**
 * Guess the module names a repository provides.
 *
 * ResourceLoader names are a convention, not a rule, so this only narrows
 * the search. A wrong guess costs nothing, because the caller still checks
 * the file names.
 *
 * @param {string} project
 * @return {string[]}
 */
export function modulePrefixesForProject( project ) {
	const info = classifyProject( project );
	if ( info.type === 'core' ) {
		return [ 'mediawiki.', 'jquery.', 'oojs', 'vue', 'codex' ];
	}
	if ( info.type === 'extension' ) {
		const name = info.name;
		return [ 'ext.' + name.charAt( 0 ).toLowerCase() + name.slice( 1 ), 'ext.' + name ];
	}
	if ( info.type === 'skin' ) {
		return [ 'skins.' + info.name.toLowerCase() ];
	}
	return [];
}

/**
 * Where a @import could point, in the order ResourceLoader tries.
 *
 * FileModule::compileLessFile puts the active skin's directory first, and
 * ResourceLoader::getLessCompiler adds core's directory last. A relative
 * import is tried against the importing file first, which the caller
 * handles because only it knows that path.
 *
 * @param {Object} opts
 * @param {string} opts.skinProject Repository that provides the skin.
 * @param {string|null} opts.skinImportPath SkinLessImportPaths entry for
 *   this skin, from its manifest. Null when the skin has none.
 * @param {string} opts.skinRef
 * @param {string} opts.coreRef
 * @return {Array<{ project: string, dir: string, ref: string }>}
 */
export function lessSearchDirs( opts ) {
	const dirs = [];
	if ( opts.skinProject && opts.skinImportPath ) {
		dirs.push( {
			project: opts.skinProject, dir: opts.skinImportPath, ref: opts.skinRef
		} );
	}
	dirs.push( { project: CORE_PROJECT, dir: CORE_LESS_IMPORT_DIR, ref: opts.coreRef } );
	return dirs;
}

/**
 * Apply the Codex path map to an import.
 *
 * @param {string} importPath
 * @return {{ project: string, path: string }|null}
 */
export function mapLessPrefix( importPath ) {
	for ( const [ prefix, target ] of Object.entries( LESS_PREFIX_MAP ) ) {
		if ( importPath.startsWith( prefix ) ) {
			return {
				project: CORE_PROJECT,
				path: target + importPath.slice( prefix.length )
			};
		}
	}
	return null;
}

/** Join two path parts, tolerating an empty directory. */
export function joinPath( dir, file ) {
	return dir ? `${ dir.replace( /\/$/, '' ) }/${ file }` : file;
}

/**
 * Collapse "." and ".." inside a path.
 *
 * @param {string} path
 * @return {string}
 */
export function normalisePath( path ) {
	const out = [];
	for ( const part of path.split( '/' ) ) {
		if ( part === '' || part === '.' ) {
			continue;
		}
		if ( part === '..' ) {
			out.pop();
		} else {
			out.push( part );
		}
	}
	return out.join( '/' );
}
