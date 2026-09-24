/**
 * Rules for changing the patch list. Pure, so they can be tested.
 */

/**
 * Decide how a new patch record joins the list.
 *
 * Two patchsets of one change are two versions of the same code; running
 * both is never wanted. So a new patchset replaces the old one. It keeps
 * the old one's place, so the order of unrelated patches does not move,
 * but it needs a review of its own: it is new code.
 *
 * @param {Array<Object>} patches The list now.
 * @param {Object} record The new patch.
 * @return {{ patches: Array<Object>, replaced: Object|null, added: boolean }}
 */
export function planAdd( patches, record ) {
	if ( patches.some( ( p ) => p.key === record.key ) ) {
		return { patches, replaced: null, added: false };
	}
	const old = patches.find( ( p ) => String( p.changeNumber ) === String( record.changeNumber ) );
	if ( !old ) {
		return { patches: [ ...patches, record ], replaced: null, added: true };
	}
	const next = { ...record, addedAt: old.addedAt, reviewed: false, enabled: false };
	return {
		patches: patches.map( ( p ) => ( p === old ? next : p ) ),
		replaced: old,
		added: true
	};
}

/**
 * The newest patchset number in a Gerrit ChangeInfo.
 *
 * @param {Object} change With CURRENT_REVISION or ALL_REVISIONS.
 * @return {number|null}
 */
export function latestPatchset( change ) {
	const revs = Object.values( ( change && change.revisions ) || {} );
	if ( !revs.length ) {
		return null;
	}
	return Math.max( ...revs.map( ( r ) => r._number ) );
}
