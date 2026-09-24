/**
 * The order patches run in, and what each still needs.
 *
 * Order matters when patches touch the same lines: a patch built on
 * another must go after it, or its merge sees the other patch's changes as
 * conflicts. Gerrit already knows the order, through relation chains and
 * Depends-On footers, so the user should not have to.
 *
 * Pure, so the rules can be tested without Gerrit.
 */

/**
 * Put patches in dependency order.
 *
 * A patch goes after another when it is built on it (its parent is the
 * other's revision, or Gerrit lists it in the chain), or when it names it
 * in Depends-On. Patches with no link keep the order they were added in.
 *
 * @param {Array<Object>} patches Patch records.
 * @return {{ order: string[], after: Object<string, string[]>, cycle: boolean }}
 */
export function stackOrder( patches ) {
	const byKey = new Map( patches.map( ( p ) => [ p.key, p ] ) );
	const byNumber = new Map( patches.map( ( p ) => [ String( p.changeNumber ), p ] ) );
	const byChangeId = new Map( patches.filter( ( p ) => p.changeId )
		.map( ( p ) => [ p.changeId, p ] ) );
	const bySha = new Map( patches.filter( ( p ) => p.sha ).map( ( p ) => [ p.sha, p ] ) );

	const needs = new Map();
	for ( const p of patches ) {
		const set = new Set();
		const deps = p.deps || {};
		const parent = p.parentSha && bySha.get( p.parentSha );
		if ( parent && parent.project === p.project ) {
			set.add( parent.key );
		}
		for ( const a of deps.ancestors || [] ) {
			const q = byNumber.get( String( a.changeNumber ) );
			if ( q ) {
				set.add( q.key );
			}
		}
		for ( const d of deps.dependsOn || [] ) {
			const q = ( d.changeNumber && byNumber.get( String( d.changeNumber ) ) ) ||
				( d.changeId && byChangeId.get( d.changeId ) );
			if ( q ) {
				set.add( q.key );
			}
		}
		set.delete( p.key );
		needs.set( p.key, set );
	}

	const addedOrder = patches.slice().sort( ( a, b ) => ( a.addedAt || 0 ) - ( b.addedAt || 0 ) );
	const done = new Set();
	const order = [];
	let progress = true;
	while ( order.length < patches.length && progress ) {
		progress = false;
		// Take the earliest-added patch whose needs are all placed.
		for ( const p of addedOrder ) {
			if ( !done.has( p.key ) && [ ...needs.get( p.key ) ].every( ( k ) => done.has( k ) ) ) {
				done.add( p.key );
				order.push( p.key );
				progress = true;
				break;
			}
		}
	}
	// Depends-On can loop. Keep the rest in the order they were added.
	const cycle = order.length < patches.length;
	for ( const p of addedOrder ) {
		if ( !done.has( p.key ) ) {
			order.push( p.key );
		}
	}

	const after = {};
	for ( const [ key, set ] of needs ) {
		after[ key ] = [ ...set ].filter( ( k ) => byKey.has( k ) );
	}
	return { order, after, cycle };
}

/**
 * Say, for each thing a patch needs, whether it is there.
 *
 * Merged is not enough: a change merged after a wiki's branch was cut is
 * not on that wiki. So a merged dependency counts only if it is deployed
 * to the wiki's branch, which the caller checks per wiki.
 *
 * @param {Object} patch
 * @param {Array<Object>} patches Every patch in the list.
 * @param {Object<string, string>} deployed Change number to
 *   'deployed' | 'not-deployed' | 'unknown', for merged dependencies.
 * @return {Array<{ kind: 'chain'|'depends-on', changeNumber: string|null,
 *   subject: string|null, project: string|null, state: string, ok: boolean,
 *   note: string|null }>}
 */
export function dependencyReport( patch, patches, deployed = {} ) {
	const byNumber = new Map( patches.map( ( p ) => [ String( p.changeNumber ), p ] ) );
	const byChangeId = new Map( patches.filter( ( p ) => p.changeId )
		.map( ( p ) => [ p.changeId, p ] ) );
	const deps = patch.deps || {};
	const rows = [];

	const judge = ( kind, dep, wantPatchset ) => {
		const here = ( dep.changeNumber && byNumber.get( String( dep.changeNumber ) ) ) ||
			( dep.changeId && byChangeId.get( dep.changeId ) );
		const row = {
			kind,
			changeNumber: dep.changeNumber || null,
			subject: dep.subject || null,
			project: dep.project || patch.project,
			state: null, ok: false, note: null
		};
		if ( here ) {
			row.state = 'in-list';
			row.ok = true;
			if ( wantPatchset && here.patchset !== wantPatchset ) {
				row.note = `The chain is built on PS${ wantPatchset }; the list has PS${ here.patchset }.`;
			}
		} else if ( dep.status === 'MERGED' ) {
			const d = deployed[ String( dep.changeNumber ) ] || 'unknown';
			row.state = d;
			row.ok = d === 'deployed';
			if ( d === 'not-deployed' ) {
				row.note = "Merged, but not on this wiki's branch yet.";
			} else if ( d === 'unknown' ) {
				row.note = "Merged; not yet checked against this wiki's branch.";
			}
		} else if ( dep.status === 'ABANDONED' ) {
			row.state = 'abandoned';
			row.note = 'Abandoned in Gerrit.';
		} else if ( dep.status === 'UNKNOWN' || !dep.changeNumber ) {
			row.state = 'unknown';
			row.note = `Gerrit has no change for ${ dep.ref }.`;
		} else {
			row.state = 'not-added';
		}
		rows.push( row );
	};

	for ( const a of deps.ancestors || [] ) {
		judge( 'chain', a, a.patchset );
	}
	for ( const d of deps.dependsOn || [] ) {
		judge( 'depends-on', d, null );
	}
	return rows;
}
