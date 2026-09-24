/**
 * What the toolbar badge says about a tab.
 *
 * The badge is the only thing a user sees without opening the popup. A
 * patch that refuses to run must look different from a page with nothing
 * to do, or the user will think the patch is broken.
 *
 * Pure, so the rules can be tested without a browser.
 */

import { STATUS } from '../shared/constants.js';

export const COLOURS = {
	good: '#14866d',
	warn: '#ac6600',
	bad: '#d73333',
	quiet: '#72777d'
};

const GOOD = new Set( [
	STATUS.APPLIED, STATUS.APPLIED_NEW, STATUS.MERGED, STATUS.STYLE_INJECTED
] );
const BAD = new Set( [ STATUS.CONFLICT, STATUS.TIMED_OUT ] );
const WARN = new Set( [
	STATUS.BASE_SKEW, STATUS.AMBIGUOUS, STATUS.UNMATCHED, STATUS.STYLE_SKIPPED
] );

const NONE = { text: '', colour: COLOURS.quiet, title: 'WikimediaPatched' };

/**
 * @param {Object|null} d Diagnosis of the tab, from the worker.
 * @return {{ text: string, colour: string, title: string }}
 */
export function badgeFor( d ) {
	// Nothing to do here: not a wiki, switched off, or no patches.
	if ( !d || !d.siteKind || !d.enabled || !d.patchCount ) {
		return NONE;
	}

	// The extension wants something from the user before it can act.
	if ( !d.hasPermission ) {
		return {
			text: '!', colour: COLOURS.warn,
			title: `WikimediaPatched needs permission for ${ d.origin }. Open the popup.`
		};
	}
	if ( !d.acknowledged ) {
		return {
			text: '!', colour: COLOURS.warn,
			title: `${ d.origin } is a production wiki. Confirm in the popup to apply patches.`
		};
	}
	if ( !d.readyPatchCount ) {
		// Switched off on purpose is quiet; waiting for a review is not.
		return d.unreviewedCount ? {
			text: '!', colour: COLOURS.warn,
			title: `${ d.unreviewedCount } patch(es) waiting for review. Open the popup.`
		} : NONE;
	}

	const report = d.report;
	if ( !report ) {
		return {
			text: '?', colour: COLOURS.quiet,
			title: 'The page did not answer. Reload it.'
		};
	}
	const files = report.files || [];
	const elevated = files.find( ( f ) => f.status === STATUS.BLOCKED_ELEVATED );
	if ( elevated ) {
		return { text: '!', colour: COLOURS.bad, title: elevated.reason };
	}
	const page = files.find( ( f ) => f.status === STATUS.BLOCKED_PAGE );
	if ( page ) {
		return { text: 'off', colour: COLOURS.quiet, title: page.reason };
	}
	if ( !report.active ) {
		return {
			text: '!', colour: COLOURS.bad,
			title: report.reason === 'timed-out' ?
				'The patch data came too late for this page. Reload it.' :
				`No patch applied: ${ report.reason || 'unknown reason' }.`
		};
	}

	const counted = files.filter( ( f ) => f.status !== STATUS.SERVER_SIDE &&
		f.status !== STATUS.PENDING );
	const applied = counted.filter( ( f ) => GOOD.has( f.status ) ).length;
	const worst = counted.some( ( f ) => BAD.has( f.status ) ) ? 'bad' :
		counted.some( ( f ) => WARN.has( f.status ) ) ? 'warn' : 'good';

	// Nothing landed, and nothing went wrong: the patch's modules are just
	// not on this page, as VisualEditor's are not until the user edits.
	// Green would read as "applied".
	if ( !applied && worst === 'good' ) {
		return {
			text: `0/${ counted.length }`,
			colour: COLOURS.quiet,
			title: counted.length ?
				"None of the patched files are used on this page yet." :
				'The patches change nothing this page uses.'
		};
	}
	return {
		text: `${ applied }/${ counted.length }`,
		colour: COLOURS[ worst ],
		title: `${ applied } of ${ counted.length } file(s) applied` +
			( worst === 'good' ? '.' : '. Open the popup for the problems.' )
	};
}
