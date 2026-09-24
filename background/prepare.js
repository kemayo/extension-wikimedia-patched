/**
 * Read a Gerrit change and build the payload that the page needs.
 *
 * This runs in the background worker, at the moment the user adds or
 * refreshes a patch. The page never talks to Gerrit.
 */

import {
	getChange, pickRevision, listFiles, getFileContent, resolveChangeNumber
} from './gerrit.js';
import {
	KIND, classifyPath, isClientSide, diffMessages, diffManifest
} from './patch-model.js';
import { modulePrefixesForProject } from '../shared/mw-layout.js';
import { listDirectory } from './gitiles.js';
import { isPlainCss } from '../shared/less-compile.js';
import { STATUS } from '../shared/constants.js';
import { patchKey } from './store.js';

/**
 * Build everything the content script needs for one patch.
 *
 * @param {ReturnType<import('./gerrit.js').parsePatchRef>} ref
 * @return {Promise<Object>} The patch payload.
 */
export async function preparePatch( ref ) {
	const changeNumber = await resolveChangeNumber( ref );
	const change = await getChange( changeNumber );
	const revision = pickRevision( change, ref.patchset );
	const files = await listFiles( changeNumber, revision.sha );
	const parentSha = parentOf( change, revision.sha );

	const payload = {
		key: patchKey( changeNumber, revision.number ),
		changeNumber,
		patchset: revision.number,
		sha: revision.sha,
		parentSha,
		project: change.project,
		branch: change.branch,
		subject: change.subject,
		owner: ( change.owner && ( change.owner.name || change.owner.email ) ) || 'unknown',
		status: change.status,
		modulePrefixes: modulePrefixesForProject( change.project ),
		messages: {},
		styles: [],
		pendingStyles: [],
		replaceFiles: [],
		newFiles: [],
		skipped: [],
		notes: []
	};

	// Read every file in parallel. Gerrit is fine with this and a change is small.
	const jobs = Object.entries( files ).map( async ( [ path, info ] ) => {
		const kind = classifyPath( path );
		const isNew = info.status === 'A';
		const isDeleted = info.status === 'D';

		if ( isDeleted ) {
			payload.skipped.push( {
				path, kind, status: STATUS.UNMATCHED,
				reason: 'The patch deletes this file. The extension cannot remove a loaded file.'
			} );
			return;
		}
		// A manifest is read too: its `styles` and `messages` lists say what the
		// extension must inject itself.
		if ( !isClientSide( kind ) && kind !== KIND.MANIFEST ) {
			payload.skipped.push( {
				path, kind, status: STATUS.SERVER_SIDE,
				reason: kind === KIND.TEST ?
					'Test code never runs on a wiki.' :
					'This file runs on the server. A wiki must deploy it.'
			} );
			return;
		}

		const [ source, parentSource ] = await Promise.all( [
			getFileContent( changeNumber, revision.sha, path ),
			isNew ? Promise.resolve( null ) :
				getFileContent( changeNumber, revision.sha, path, { parent: true } )
		] );

		if ( source === null ) {
			payload.skipped.push( {
				path, kind, status: STATUS.UNMATCHED, reason: 'Gerrit returned no content.'
			} );
			return;
		}

		if ( kind === KIND.I18N ) {
			handleI18n( payload, path, parentSource, source );
			return;
		}
		if ( kind === KIND.MANIFEST ) {
			handleManifest( payload, path, parentSource, source );
			return;
		}
		if ( kind === KIND.CSS || kind === KIND.LESS ) {
			if ( isPlainCss( path ) ) {
				payload.styles.push( { path, css: source } );
			} else {
				// LESS needs the active skin to resolve its imports, and only
				// the page knows the skin. The page asks for it later.
				payload.pendingStyles.push( { path, source } );
			}
			return;
		}

		// JS and JSON data files go into the module payload.
		const entry = { path, kind, source, parentSource };
		if ( isNew ) {
			payload.newFiles.push( entry );
		} else {
			payload.replaceFiles.push( entry );
		}
	} );

	await Promise.all( jobs );
	await attachSiblings( payload, parentSha );

	// Sort so the popup always shows the same order.
	const byPath = ( a, b ) => a.path.localeCompare( b.path );
	payload.replaceFiles.sort( byPath );
	payload.newFiles.sort( byPath );
	payload.styles.sort( byPath );
	payload.pendingStyles.sort( byPath );
	payload.skipped.sort( byPath );

	return payload;
}

/** Merge the English messages a patch adds. Other languages are not applied. */
function handleManifestFileNote( payload, text ) {
	if ( !payload.notes.includes( text ) ) {
		payload.notes.push( text );
	}
}

function handleI18n( payload, path, parentSource, source ) {
	if ( !/\/en\.json$/.test( path ) ) {
		handleManifestFileNote( payload,
			`${ path }: only English messages are applied.` );
		return;
	}
	const diff = diffMessages( parentSource, source );
	Object.assign( payload.messages, diff.messages );
	if ( !diff.added.length && !diff.changed.length ) {
		handleManifestFileNote( payload, `${ path }: no message changed.` );
	}
}

/**
 * Report what an extension.json change means.
 *
 * The extension can honour new `styles` and `messages` entries, because it
 * injects those itself. Everything else needs the server.
 */
function handleManifest( payload, path, parentSource, source ) {
	const diff = diffManifest( parentSource, source );

	for ( const [ module, files ] of Object.entries( diff.addedPackageFiles ) ) {
		handleManifestFileNote( payload,
			`${ path }: adds ${ files.length } file(s) to ${ module }.` );
	}
	if ( diff.newModules.length ) {
		payload.skipped.push( {
			path, kind: KIND.MANIFEST, status: STATUS.SERVER_SIDE,
			reason: `Registers new modules (${ diff.newModules.join( ', ' ) }). ` +
				'A wiki must deploy this.'
		} );
	}
	if ( diff.otherChanges ) {
		payload.skipped.push( {
			path, kind: KIND.MANIFEST, status: STATUS.SERVER_SIDE,
			reason: 'Changes settings outside ResourceModules. A wiki must deploy this.'
		} );
	}
	const styleCount = Object.values( diff.addedStyles ).flat().length;
	const messageCount = Object.values( diff.addedMessages ).flat().length;
	if ( styleCount || messageCount ) {
		handleManifestFileNote( payload,
			`${ path }: registers ${ styleCount } stylesheet(s) and ` +
			`${ messageCount } message(s). The extension injects these itself.` );
	}
}


/**
 * Find the commit a revision builds on.
 *
 * @param {Object} change ChangeInfo.
 * @param {string} sha Revision SHA.
 * @return {string|null}
 */
function parentOf( change, sha ) {
	const commit = change.revisions && change.revisions[ sha ] && change.revisions[ sha ].commit;
	const parents = commit && commit.parents;
	return parents && parents.length ? parents[ 0 ].commit : null;
}

/**
 * Record the names of each new file's siblings.
 *
 * A new file is in no module yet, so the extension must work out which
 * module owns its directory. The sibling names are the evidence: the module
 * whose file list holds them owns the directory too.
 *
 * The listing uses the parent commit, so the new file is not in it.
 *
 * @param {Object} payload
 * @param {string|null} parentSha
 */
async function attachSiblings( payload, parentSha ) {
	if ( !parentSha || !payload.newFiles.length ) {
		return;
	}
	const dirs = new Set( payload.newFiles.map( ( f ) => dirname( f.path ) ) );
	const listings = new Map();
	await Promise.all( [ ...dirs ].map( async ( dir ) => {
		listings.set( dir, await listDirectory( payload.project, parentSha, dir ) );
	} ) );
	for ( const file of payload.newFiles ) {
		const names = listings.get( dirname( file.path ) );
		file.siblings = names || [];
		// Say so when the listing failed, so the page can explain itself.
		file.siblingsUnknown = names === null || names === undefined;
	}
}

function dirname( path ) {
	const i = path.lastIndexOf( '/' );
	return i === -1 ? '' : path.slice( 0, i );
}
