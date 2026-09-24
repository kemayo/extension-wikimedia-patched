/**
 * What a patch needs besides itself.
 *
 * Two kinds of need are written down in Gerrit: the unmerged changes a
 * patch is stacked on (its relation chain), and the changes its commit
 * message names in a Depends-On: footer. A third kind is not written
 * down: the merged changes under the patch that a wiki's branch does not
 * have yet. Merged is not the same as deployed. A change merged after the
 * branch cut is on master only, until a backport or the next train.
 */

import { gerritGet } from './gerrit.js';
import { logRange } from './gitiles.js';

/**
 * Find the Depends-On: footers in a commit message.
 *
 * @param {string} message
 * @return {string[]} Change-Ids, change numbers or URLs, as written.
 */
export function parseDependsOn( message ) {
	const out = [];
	const re = /^Depends-On:\s*(\S+)\s*$/gm;
	let m;
	while ( ( m = re.exec( String( message || '' ) ) ) !== null ) {
		if ( !out.includes( m[ 1 ] ) ) {
			out.push( m[ 1 ] );
		}
	}
	return out;
}

/**
 * Pick the ancestors out of a /related answer.
 *
 * Gerrit lists the whole chain, newest first, so everything after the
 * current revision is under it. A merged change does not appear at all.
 *
 * @param {Array} related The `changes` array from /related.
 * @param {string} sha The current revision.
 * @return {Array<{ changeNumber: string, patchset: number, sha: string,
 *   changeId: string, status: string, subject: string }>} Nearest first.
 */
export function ancestorsFrom( related, sha ) {
	const at = related.findIndex( ( c ) => c.commit && c.commit.commit === sha );
	if ( at === -1 ) {
		return [];
	}
	return related.slice( at + 1 ).map( ( c ) => ( {
		changeNumber: String( c._change_number ),
		patchset: c._revision_number,
		sha: c.commit.commit,
		changeId: c.change_id,
		status: c.status,
		subject: c.commit.subject
	} ) );
}

/**
 * Turn a Depends-On value into the change it names.
 *
 * One Change-Id can name several changes: the original on master and its
 * backports. A dependency means the master one, unless there is none.
 *
 * @param {Array} candidates Gerrit ChangeInfo list for the Change-Id.
 * @return {Object|null}
 */
export function pickDependency( candidates ) {
	if ( !candidates.length ) {
		return null;
	}
	const score = ( c ) => ( c.branch === 'master' ? 0 : 2 ) + ( c.status === 'ABANDONED' ? 1 : 0 );
	return candidates.slice().sort( ( a, b ) => score( a ) - score( b ) )[ 0 ];
}

/**
 * Read what a patch is stacked on and what it names as dependencies.
 *
 * Runs once, when the patch is added or read again.
 *
 * @param {string} changeNumber
 * @param {string} sha
 * @param {Object} change Gerrit ChangeInfo, with ALL_COMMITS.
 * @return {Promise<{ ancestors: Array, dependsOn: Array }>}
 */
export async function readDependencies( changeNumber, sha, change ) {
	let related = [];
	try {
		related = ( await gerritGet(
			`changes/${ encodeURIComponent( changeNumber ) }/revisions/${ sha }/related`
		) ).changes || [];
	} catch ( e ) {
		// No chain information is not fatal; the patch still stands alone.
	}
	const ancestors = ancestorsFrom( related, sha );

	// Depends-On can sit on any commit of the chain, as patchdemo reads it.
	const messages = [ change.revisions[ sha ].commit.message ];
	await Promise.all( ancestors.map( async ( a ) => {
		try {
			const commit = await gerritGet(
				`changes/${ a.changeNumber }/revisions/${ a.sha }/commit` );
			messages.push( commit.message );
		} catch ( e ) {}
	} ) );

	const wanted = [ ...new Set( messages.flatMap( parseDependsOn ) ) ]
		.filter( ( id ) => id !== change.change_id );
	const dependsOn = [];
	await Promise.all( wanted.map( async ( value ) => {
		// A change number or URL is rare but allowed; a Change-Id is usual.
		const number = /(?:^|\/)([0-9]+)\/?$/.exec( value );
		const query = number ? `change:${ number[ 1 ] }` : `change:${ value }`;
		let hits = [];
		try {
			hits = await gerritGet(
				`changes/?q=${ encodeURIComponent( query ) }&o=CURRENT_REVISION` );
		} catch ( e ) {}
		const dep = pickDependency( hits );
		dependsOn.push( dep ? {
			ref: value,
			changeNumber: String( dep._number ),
			patchset: dep.revisions && dep.current_revision ?
				dep.revisions[ dep.current_revision ]._number : null,
			sha: dep.current_revision || null,
			changeId: dep.change_id,
			project: dep.project,
			branch: dep.branch,
			status: dep.status,
			subject: dep.subject
		} : { ref: value, changeNumber: null, status: 'UNKNOWN', subject: null } );
	} ) );
	dependsOn.sort( ( a, b ) => String( a.ref ).localeCompare( String( b.ref ) ) );

	return { ancestors, dependsOn };
}

/** Deploy answers for one branch; a branch rarely changes within minutes. */
const deployCache = new Map();
const DEPLOY_TTL_MS = 10 * 60 * 1000;

async function cached( key, fn ) {
	const hit = deployCache.get( key );
	if ( hit && Date.now() - hit.at < DEPLOY_TTL_MS ) {
		return hit.value;
	}
	const value = await fn();
	deployCache.set( key, { value, at: Date.now() } );
	return value;
}

/**
 * The Change-Ids backported to a branch.
 *
 * A backport is a new change with the same Change-Id, so it never shows
 * as the master commit being "in" the branch. One query covers them all.
 *
 * @param {string} project
 * @param {string} branch
 * @return {Promise<Set<string>>}
 */
function backportsOn( project, branch ) {
	return cached( `backports\u0000${ project }\u0000${ branch }`, async () => {
		try {
			const q = `project:${ project } branch:${ branch } status:merged`;
			const hits = await gerritGet( `changes/?q=${ encodeURIComponent( q ) }&n=500` );
			return new Set( hits.map( ( c ) => c.change_id ) );
		} catch ( e ) {
			return new Set();
		}
	} );
}

/**
 * Say whether a merged change is on a wiki's branch.
 *
 * @param {{ changeNumber: string, changeId: string, project: string }} dep
 * @param {string} branch
 * @return {Promise<'deployed'|'not-deployed'|'unknown'>}
 */
export function deployedOn( dep, branch ) {
	return cached( `in\u0000${ dep.changeNumber }\u0000${ branch }`, async () => {
		try {
			const inc = await gerritGet( `changes/${ dep.changeNumber }/in` );
			if ( ( inc.branches || [] ).includes( branch ) ) {
				return 'deployed';
			}
		} catch ( e ) {
			return 'unknown';
		}
		return ( await backportsOn( dep.project, branch ) ).has( dep.changeId ) ?
			'deployed' : 'not-deployed';
	} );
}

/**
 * The merged changes under a patch that a wiki's branch does not have.
 *
 * Backports are left out, because the wiki has those, under another sha.
 *
 * @param {string} project
 * @param {string} parentSha The patch's parent.
 * @param {string} branch
 * @return {Promise<{ commits: Array, more: boolean }|null>} Null when Gitiles
 *   would not answer; Gitiles is rate limited hard.
 */
export function undeployedBase( project, parentSha, branch ) {
	return cached( `base\u0000${ project }\u0000${ parentSha }\u0000${ branch }`, async () => {
		const range = await logRange( project, branch, parentSha );
		if ( !range ) {
			return null;
		}
		const backports = await backportsOn( project, branch );
		return {
			commits: range.commits.filter( ( c ) => !c.changeId || !backports.has( c.changeId ) ),
			more: range.more
		};
	} );
}
