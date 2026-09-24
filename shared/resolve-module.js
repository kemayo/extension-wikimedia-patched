/**
 * Work out which ResourceLoader module owns a repository file.
 *
 * ResourceLoader names a packaged file relative to the module's
 * localBasePath. That is usually the extension root, so the repository path
 * is the payload key already. But a module can set its own base path, and
 * then the keys are bare file names. Both must work.
 *
 * Every function here is pure. The page passes in what it sees, and the
 * tests pass in fixtures.
 */

export function basename( path ) {
	const i = path.lastIndexOf( '/' );
	return i === -1 ? path : path.slice( i + 1 );
}

export function dirname( path ) {
	const i = path.lastIndexOf( '/' );
	return i === -1 ? '' : path.slice( 0, i );
}

/** Replace the last path component. */
function withBasename( path, name ) {
	const dir = dirname( path );
	return dir ? dir + '/' + name : name;
}

/**
 * Resolve a relative require path, the same way ResourceLoader does.
 *
 * @param {string} relativePath Starts with ./ or ../
 * @param {string} basePath Path of the file, not the directory.
 * @return {string|null} Null if the path is not relative.
 */
export function resolveRelativePath( relativePath, basePath ) {
	const relParts = relativePath.match( /^((?:\.\.?\/)+)(.*)$/ );
	if ( !relParts ) {
		return null;
	}
	const baseDirParts = basePath.split( '/' );
	baseDirParts.pop();

	const prefixes = relParts[ 1 ].split( '/' );
	prefixes.pop();

	let reachedRoot = false;
	let prefix;
	while ( ( prefix = prefixes.pop() ) !== undefined ) {
		if ( prefix === '..' ) {
			reachedRoot = !baseDirParts.length || reachedRoot;
			if ( !reachedRoot ) {
				baseDirParts.pop();
			} else {
				baseDirParts.push( prefix );
			}
		}
	}
	return ( baseDirParts.length ? baseDirParts.join( '/' ) + '/' : '' ) + relParts[ 2 ];
}

/**
 * Find the module that holds a file the patch changes.
 *
 * @param {string} repoPath
 * @param {Array<{name: string, files: string[]}>} modules Modules seen on this page.
 * @return {{ status: 'exact'|'suffix'|'ambiguous'|'none',
 *            matches: Array<{ module: string, key: string }> }}
 */
export function matchFileToModule( repoPath, modules ) {
	const exact = [];
	for ( const mod of modules ) {
		if ( mod.files.includes( repoPath ) ) {
			exact.push( { module: mod.name, key: repoPath } );
		}
	}
	if ( exact.length ) {
		return { status: 'exact', matches: exact };
	}

	// A key may be a path suffix, because the module set its own base path.
	// Only accept a whole path component, so "Check.js" cannot match
	// "MyCheck.js".
	const candidates = [];
	for ( const mod of modules ) {
		for ( const key of mod.files ) {
			if ( repoPath.endsWith( '/' + key ) ) {
				candidates.push( { module: mod.name, key, length: key.length } );
			}
		}
	}
	if ( !candidates.length ) {
		return { status: 'none', matches: [] };
	}

	// The longest key is the most specific, so it is the most likely.
	const longest = Math.max( ...candidates.map( ( c ) => c.length ) );
	const best = candidates.filter( ( c ) => c.length === longest );
	const names = new Set( best.map( ( c ) => c.module ) );
	const matches = best.map( ( c ) => ( { module: c.module, key: c.key } ) );

	return { status: names.size > 1 ? 'ambiguous' : 'suffix', matches };
}

/**
 * Find the module that should hold a file the patch adds.
 *
 * A new file is in no module, so the extension looks for evidence that a
 * module already owns the file's directory. Three kinds of evidence, best
 * first.
 *
 * @param {string} repoPath Path of the new file.
 * @param {string[]} siblings Names of the other files in the same directory.
 *   May be empty when the listing failed.
 * @param {Array<{name: string, files: string[]}>} modules Modules seen on this page.
 * @param {Array<{ repoPath: string, module: string, key: string }>} anchors
 *   Files of the same patch that are already placed.
 * @return {{ status: 'siblings'|'anchor'|'directory'|'ambiguous'|'none',
 *            module: string|null, key: string|null,
 *            candidates: Array<{ module: string, key: string }> }}
 */
export function inferModuleForNewFile( repoPath, siblings, modules, anchors = [] ) {
	const name = basename( repoPath );
	const dir = dirname( repoPath );
	const none = { status: 'none', module: null, key: null, candidates: [] };

	// 1. Sibling names. A module that already holds this file's neighbours
	//    owns the directory.
	const siblingSet = new Set( ( siblings || [] ).filter( ( s ) => s !== name ) );
	if ( siblingSet.size ) {
		const hits = [];
		for ( const mod of modules ) {
			const shared = mod.files.filter( ( key ) => siblingSet.has( basename( key ) ) );
			if ( shared.length ) {
				hits.push( { module: mod.name, key: withBasename( shared[ 0 ], name ),
					score: shared.length } );
			}
		}
		if ( hits.length ) {
			const top = Math.max( ...hits.map( ( h ) => h.score ) );
			const best = hits.filter( ( h ) => h.score === top );
			if ( best.length === 1 ) {
				return {
					status: 'siblings', module: best[ 0 ].module, key: best[ 0 ].key,
					candidates: best.map( strip )
				};
			}
			return { status: 'ambiguous', module: null, key: null, candidates: best.map( strip ) };
		}
	}

	// 2. Another file of the same patch, in the same directory, that is
	//    already placed. Its key tells us the naming.
	const anchor = anchors.find( ( a ) => dirname( a.repoPath ) === dir );
	if ( anchor ) {
		return {
			status: 'anchor', module: anchor.module,
			key: withBasename( anchor.key, name ),
			candidates: [ { module: anchor.module, key: withBasename( anchor.key, name ) } ]
		};
	}

	// 3. A module that holds keys with a directory the new file is under.
	const byDir = [];
	for ( const mod of modules ) {
		for ( const key of mod.files ) {
			const keyDir = dirname( key );
			if ( keyDir && ( dir === keyDir || dir.endsWith( '/' + keyDir ) ) ) {
				byDir.push( { module: mod.name, key: keyDir + '/' + name, length: keyDir.length } );
			}
		}
	}
	if ( byDir.length ) {
		const longest = Math.max( ...byDir.map( ( c ) => c.length ) );
		const best = byDir.filter( ( c ) => c.length === longest );
		const names = new Set( best.map( ( c ) => c.module ) );
		if ( names.size === 1 ) {
			return {
				status: 'directory', module: best[ 0 ].module, key: best[ 0 ].key,
				candidates: best.map( strip )
			};
		}
		return { status: 'ambiguous', module: null, key: null, candidates: best.map( strip ) };
	}

	return none;
}

function strip( c ) {
	return { module: c.module, key: c.key };
}
