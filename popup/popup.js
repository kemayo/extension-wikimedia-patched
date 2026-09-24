/**
 * Popup: the switch, the patch list, and what each patch did on this tab.
 */

import { ext } from '../shared/webext.js';
import { BUILD_ID, MSG, STATUS, GERRIT_BASE, optionalPatternFor } from '../shared/constants.js';
import { stackOrder } from '../shared/stack-order.js';

const el = ( id ) => document.getElementById( id );

/** How each result reads, and which colour class it gets. */
const STATUS_LABEL = {
	[ STATUS.APPLIED ]: [ 'applied', 's-good' ],
	[ STATUS.APPLIED_NEW ]: [ 'added', 's-good' ],
	[ STATUS.MERGED ]: [ 'merged', 's-good' ],
	[ STATUS.STYLE_INJECTED ]: [ 'styled', 's-good' ],
	[ STATUS.BASE_SKEW ]: [ 'base skew', 's-warn' ],
	[ STATUS.AMBIGUOUS ]: [ 'ambiguous', 's-warn' ],
	[ STATUS.UNMATCHED ]: [ 'unmatched', 's-warn' ],
	[ STATUS.STYLE_SKIPPED ]: [ 'style skipped', 's-warn' ],
	[ STATUS.NOT_ON_PAGE ]: [ 'not on page', 's-skip' ],
	[ STATUS.SERVER_SIDE ]: [ 'server-side', 's-skip' ],
	[ STATUS.CONFLICT ]: [ 'conflict', 's-bad' ],
	[ STATUS.TIMED_OUT ]: [ 'timed out', 's-bad' ],
	[ STATUS.BLOCKED_PAGE ]: [ 'blocked here', 's-bad' ],
	[ STATUS.BLOCKED_ELEVATED ]: [ 'needs confirming', 's-bad' ],
	[ STATUS.PENDING ]: [ 'no word yet', 's-skip' ]
};

async function send( type, extra = {} ) {
	const reply = await ext.runtime.sendMessage( { type, ...extra } );
	if ( !reply || !reply.ok ) {
		throw new Error( reply ? reply.error : 'The background worker did not answer.' );
	}
	return reply.result;
}

/** What the worker and the page each say about the current tab. */
async function currentTab() {
	const [ tab ] = await ext.tabs.query( { active: true, currentWindow: true } );
	if ( !tab ) {
		return { tab: null, report: null, diagnosis: null };
	}
	const { diagnosis } = await send( MSG.GET_DIAGNOSIS, { tabId: tab.id } );
	return { tab, report: diagnosis && diagnosis.report, diagnosis };
}

/**
 * Explain the current tab in one line, and offer the fix.
 *
 * A patch that does nothing is the common complaint, and the cause is
 * almost never the patch. It is the switch, the site, or a page that
 * loaded before the extension was ready.
 *
 * @param {Object|null} tab
 * @param {Object|null} d Diagnosis from the worker.
 */
function renderSiteStatus( tab, d ) {
	const box = el( 'site-status' );
	const text = el( 'site-status-text' );
	const allow = el( 'site-allow' );
	allow.hidden = true;
	box.classList.remove( 'ok' );

	if ( !d || d.reason === 'no-tab' ) {
		box.hidden = true;
		return;
	}
	box.hidden = false;

	if ( !d.siteKind ) {
		text.textContent = `${ d.origin || d.url || 'This page' } is not a wiki ` +
			'the extension knows.';
		return;
	}
	if ( !d.hasPermission ) {
		text.textContent = `The extension has no permission for ${ d.origin }.`;
		allow.hidden = false;
		allow.dataset.origin = d.origin;
		return;
	}
	if ( !d.enabled ) {
		text.textContent = 'The switch is off.';
		return;
	}
	if ( !d.acknowledged ) {
		text.textContent = `${ d.origin } is a production wiki. A patch runs with ` +
			'your account, so it needs your say-so for this browser session.';
		allow.hidden = false;
		allow.dataset.origin = d.origin;
		return;
	}
	if ( !d.patchCount ) {
		text.textContent = 'No patches added yet.';
		return;
	}
	if ( !d.readyPatchCount ) {
		text.textContent = 'No patch is both reviewed and switched on.';
		return;
	}
	if ( !d.report ) {
		text.textContent = 'The page has not answered. Reload the tab, and check ' +
			'that it finished loading.';
		return;
	}
	box.classList.add( 'ok' );
	text.textContent = d.report.siteNote ||
		`${ d.readyPatchCount } patch(es) active on this page.`;
}

function renderFileRows( tbody, rows, patch ) {
	tbody.replaceChildren();
	for ( const row of rows ) {
		const [ label, cls ] = STATUS_LABEL[ row.status ] || [ row.status, 's-skip' ];
		const tr = document.createElement( 'tr' );

		const path = document.createElement( 'td' );
		path.className = 'path';
		// Link to the file's diff. Gerrit shows it better than the popup can,
		// which matters most when the base does not match.
		if ( patch && !row.path.startsWith( '(' ) ) {
			const link = document.createElement( 'a' );
			link.href = `${ GERRIT_BASE }/c/${ patch.project }/+/${ patch.changeNumber }/` +
				`${ patch.patchset }/${ row.path }`;
			link.target = '_blank';
			link.rel = 'noreferrer';
			link.textContent = row.path;
			path.append( link );
		} else {
			path.textContent = row.path;
		}

		const status = document.createElement( 'td' );
		status.className = 'status ' + cls;
		status.textContent = label;

		const reason = document.createElement( 'td' );
		reason.className = 'reason';
		reason.textContent = row.reason || '';

		tr.append( path, status, reason );
		tbody.append( tr );
	}
}

/**
 * Merge what the background worker knows about a patch with what the page
 * reported. The page knows which files actually landed.
 */
function fileRowsFor( payload, report ) {
	const fromPage = new Map();
	if ( report ) {
		for ( const f of report.files || [] ) {
			if ( f.patchKey === payload.key ) {
				fromPage.set( f.path, f );
			}
		}
	}
	const rows = [];
	const add = ( path, fallbackStatus, reason ) => {
		const live = fromPage.get( path );
		rows.push( live || { path, status: fallbackStatus, reason } );
	};

	// Only the page can say what happened to a file. Until it does, say
	// nothing rather than something wrong.
	const unheard = 'The page has not reported on this file.';
	for ( const f of payload.replaceFiles ) {
		add( f.path, STATUS.PENDING, unheard );
	}
	for ( const f of payload.newFiles ) {
		add( f.path, STATUS.PENDING, unheard );
	}
	for ( const s of payload.styles ) {
		add( s.path, STATUS.PENDING, unheard );
	}
	for ( const s of payload.pendingStyles || [] ) {
		add( s.path, STATUS.PENDING, unheard );
	}
	for ( const s of payload.skipped ) {
		rows.push( { path: s.path, status: s.status, reason: s.reason } );
	}
	if ( Object.keys( payload.messages ).length ) {
		const count = Object.keys( payload.messages ).length;
		const live = fromPage.get( '(messages)' );
		rows.push( live || {
			path: '(messages)',
			status: STATUS.PENDING,
			reason: `${ count } English message(s) ready.`
		} );
	}
	return rows;
}

/**
 * Patches whose details are open.
 *
 * Every change re-renders the list, so this must outlive a render, or
 * ticking the review box would close the patch being reviewed. A patch
 * that is not reviewed yet starts open, because it does nothing until the
 * review box is ticked.
 */
const expanded = new Set();
const seenKeys = new Set();

function renderPatch( patch, payload, report, after = [] ) {
	const node = el( 'patch-template' ).content.firstElementChild.cloneNode( true );
	node.dataset.key = patch.key;
	node.classList.toggle( 'unreviewed', !patch.reviewed );

	const subject = node.querySelector( '.patch-subject' );
	subject.textContent = patch.subject || patch.key;
	subject.href = `${ GERRIT_BASE }/c/${ patch.project }/+/${ patch.changeNumber }/${ patch.patchset }`;

	node.querySelector( '.patch-meta' ).textContent =
		`${ patch.project } \u00b7 PS${ patch.patchset } \u00b7 ${ patch.owner }` +
		( patch.changeStatus === 'MERGED' ? ' \u00b7 merged' : '' );
	if ( after.length ) {
		const note = document.createElement( 'span' );
		note.className = 'patch-after';
		note.textContent = ` \u00b7 runs after ${ after.map( ( k ) => k.split( '@' )[ 0 ] ).join( ', ' ) }`;
		node.querySelector( '.patch-meta' ).append( note );
	}

	const enabled = node.querySelector( '.patch-enabled' );
	enabled.checked = patch.enabled;
	enabled.disabled = !patch.reviewed;
	enabled.title = patch.reviewed ?
		'Apply this patch' :
		'Read the code first. Open the patch and tick the review box.';

	const reviewed = node.querySelector( '.patch-reviewed' );
	reviewed.checked = patch.reviewed;

	if ( !seenKeys.has( patch.key ) ) {
		seenKeys.add( patch.key );
		if ( !patch.reviewed ) {
			expanded.add( patch.key );
		}
	}
	const open = expanded.has( patch.key );
	node.querySelector( '.patch-body' ).hidden = !open;
	node.querySelector( '.patch-expand' ).textContent = open ? '\u25be' : '\u25b8';

	const notes = node.querySelector( '.notes' );
	if ( payload && payload.notes.length ) {
		for ( const text of payload.notes ) {
			const li = document.createElement( 'li' );
			li.textContent = text;
			notes.append( li );
		}
	}

	if ( payload ) {
		renderFileRows( node.querySelector( 'table.files tbody' ),
			fileRowsFor( payload, report ), patch );
	}

	return node;
}

async function render() {
	const [ state, { tab, report, diagnosis } ] = await Promise.all( [
		send( MSG.GET_STATE ), currentTab()
	] );

	renderSiteStatus( tab, diagnosis );

	el( 'master-toggle' ).checked = state.enabled;
	el( 'master-label' ).textContent = state.enabled ? 'On' : 'Off';

	renderElevatedWarning( report );

	// Popup and worker must come from the same build, or their messages
	// disagree. Only a reload of the extension restarts the worker.
	el( 'stale-worker' ).hidden = state.buildId === BUILD_ID;

	const list = el( 'patch-list' );
	list.replaceChildren();
	el( 'empty' ).hidden = state.patches.length > 0;

	// Show the patches in the order they run. The popup works this out from
	// the same code the worker uses, rather than trusting a worker field.
	const stack = stackOrder( state.patches );
	el( 'stack-cycle' ).hidden = !stack.cycle;
	const inOrder = stack.order
		.map( ( key ) => state.patches.find( ( p ) => p.key === key ) )
		.filter( Boolean );
	lastState = state;
	for ( const patch of inOrder ) {
		let payload = null;
		try {
			payload = ( await send( MSG.GET_PATCH_PAYLOAD, { key: patch.key } ) ).payload;
		} catch ( e ) {
			// A network problem must not empty the list.
		}
		list.append( renderPatch( patch, payload, report, stack.after[ patch.key ] || [] ) );
	}

	// The stack check reads Gerrit, so draw the list first and fill it in.
	if ( lastCheck ) {
		applyStackCheck( lastCheck );
	}
	if ( tab ) {
		send( MSG.GET_STACK_CHECK, { tabId: tab.id } ).then( ( check ) => {
			lastCheck = check;
			applyStackCheck( check );
		}, () => {} );
	}
}

let lastState = null;
let lastCheck = null;

/**
 * Show what each patch still needs, for the wiki in this tab.
 *
 * @param {Object} check From the worker: branch, and per-patch results.
 */
function applyStackCheck( check ) {
	for ( const node of el( 'patch-list' ).querySelectorAll( '.patch' ) ) {
		const info = check.perPatch[ node.dataset.key ];
		const box = node.querySelector( '.needs' );
		box.replaceChildren();
		if ( !info ) {
			box.hidden = true;
			continue;
		}
		for ( const dep of info.deps ) {
			if ( dep.ok && !dep.note ) {
				continue;
			}
			const line = document.createElement( 'p' );
			line.className = dep.ok ? 'need-note' : 'need-bad';
			const what = dep.changeNumber ?
				`${ dep.kind === 'chain' ? 'Built on' : 'Depends on' } ${ dep.changeNumber }` +
				( dep.project && lastState && dep.project !== patchProject( node.dataset.key ) ?
					` (${ dep.project })` : '' ) +
				( dep.subject ? `: ${ dep.subject }` : '' ) :
				'Depends on something Gerrit does not know';
			const why = dep.note || ( dep.state === 'not-added' ? 'Not in the list.' : '' );
			line.textContent = `${ what }. ${ why }`;
			if ( !dep.ok && dep.changeNumber && dep.state !== 'abandoned' ) {
				line.append( addButton( dep.changeNumber ) );
			}
			box.append( line );
		}
		const pinned = lastState && lastState.patches.find( ( p ) => p.key === node.dataset.key );
		if ( pinned && info.latest && info.latest > pinned.patchset ) {
			const line = document.createElement( 'p' );
			line.className = 'need-bad';
			line.textContent = `PS${ info.latest } is newer than PS${ pinned.patchset }.`;
			line.append( addButton( `${ pinned.changeNumber }/${ info.latest }`, 'Update' ) );
			box.append( line );
		}
		if ( info.base && info.base.unavailable ) {
			const line = document.createElement( 'p' );
			line.className = 'need-note';
			line.textContent = `Could not list the merged changes under this patch that ` +
				`${ check.branch } lacks: Gitiles is busy. Open the popup again later.`;
			box.append( line );
		} else if ( info.base && info.base.count ) {
			box.append( baseList( info.base, check.branch ) );
		}
		box.hidden = !box.childElementCount;
	}
}

/** The project of a patch in the list, from the last state. */
function patchProject( key ) {
	const patch = lastState && lastState.patches.find( ( p ) => p.key === key );
	return patch ? patch.project : null;
}

/**
 * Say which merged changes this patch is built on that the wiki lacks.
 *
 * Most are harmless, such as translation updates, so this informs rather
 * than blocks. The ones that matter are for the user to judge.
 */
function baseList( base, branch ) {
	const details = document.createElement( 'details' );
	const summary = document.createElement( 'summary' );
	summary.textContent = `Built on ${ base.count }${ base.more ? '+' : '' } merged ` +
		`change(s) that ${ branch } does not have yet.`;
	details.append( summary );
	const ul = document.createElement( 'ul' );
	for ( const c of base.commits ) {
		const li = document.createElement( 'li' );
		li.textContent = c.subject;
		if ( c.changeId ) {
			li.append( addButton( c.changeId ) );
		}
		ul.append( li );
	}
	details.append( ul );
	return details;
}

function addButton( input, label = 'Add' ) {
	const button = document.createElement( 'button' );
	button.type = 'button';
	button.textContent = label;
	button.className = 'add-dependency';
	button.dataset.input = input;
	return button;
}

/**
 * Show the block when the account holds elevated rights.
 *
 * The page refuses to run a patch until the user confirms, because an
 * injected patch inherits every right the account has.
 */
function renderElevatedWarning( report ) {
	const box = el( 'elevated-warning' );
	const blocked = report && ( report.files || [] )
		.find( ( f ) => f.status === STATUS.BLOCKED_ELEVATED );
	if ( !blocked ) {
		box.hidden = true;
		return;
	}
	el( 'elevated-text' ).textContent = blocked.reason;
	box.hidden = false;
}

el( 'reload-extension' ).addEventListener( 'click', () => {
	ext.runtime.reload();
} );

el( 'site-allow' ).addEventListener( 'click', async ( ev ) => {
	const origin = ev.target.dataset.origin;
	if ( !origin ) {
		return;
	}
	// The request must name a pattern the manifest declared, not the bare
	// origin. The permission may already be there, in which case this only
	// records the acknowledgement.
	const pattern = optionalPatternFor( origin );
	if ( pattern ) {
		const granted = await ext.permissions.request( { origins: [ pattern ] } );
		if ( !granted ) {
			return;
		}
	}
	await send( MSG.ACK_SITE, { origin } );
	const [ tab ] = await ext.tabs.query( { active: true, currentWindow: true } );
	if ( tab ) {
		await ext.tabs.reload( tab.id );
	}
	window.close();
} );

el( 'elevated-ack' ).addEventListener( 'click', async () => {
	const [ tab ] = await ext.tabs.query( { active: true, currentWindow: true } );
	if ( !tab || !tab.url ) {
		return;
	}
	await send( MSG.ACK_ELEVATED, { origin: new URL( tab.url ).origin } );
	await ext.tabs.reload( tab.id );
	window.close();
} );

el( 'master-toggle' ).addEventListener( 'change', async ( ev ) => {
	await send( MSG.SET_ENABLED, { value: ev.target.checked } );
	render();
} );

/**
 * Add a patch, open it, and say if it replaced another patchset.
 *
 * @param {string} input
 */
async function addPatch( input ) {
	const { payload, replaced } = await send( MSG.ADD_PATCH, { input } );
	// Open the new patch, so its review box is in view.
	expanded.add( payload.key );
	const note = el( 'add-note' );
	if ( replaced ) {
		note.textContent = `Replaced PS${ replaced.split( '@' )[ 1 ] } of ` +
			`${ payload.changeNumber } with PS${ payload.patchset }. Review it again.`;
		note.hidden = false;
	} else {
		note.hidden = true;
	}
	await render();
}

el( 'add-form' ).addEventListener( 'submit', async ( ev ) => {
	ev.preventDefault();
	const input = el( 'add-input' );
	const error = el( 'add-error' );
	const button = el( 'add-button' );
	error.hidden = true;
	button.disabled = true;
	try {
		await addPatch( input.value );
		input.value = '';
	} catch ( e ) {
		error.textContent = e.message;
		error.hidden = false;
	} finally {
		button.disabled = false;
	}
} );

el( 'patch-list' ).addEventListener( 'click', async ( ev ) => {
	const item = ev.target.closest( '.patch' );
	if ( !item ) {
		return;
	}
	const key = item.dataset.key;

	if ( ev.target.matches( '.add-dependency' ) ) {
		ev.target.disabled = true;
		try {
			await addPatch( ev.target.dataset.input );
		} catch ( e ) {
			ev.target.disabled = false;
			ev.target.title = e.message;
		}
		return;
	}
	if ( ev.target.matches( '.patch-expand' ) ) {
		const body = item.querySelector( '.patch-body' );
		body.hidden = !body.hidden;
		ev.target.textContent = body.hidden ? '\u25b8' : '\u25be';
		if ( body.hidden ) {
			expanded.delete( key );
		} else {
			expanded.add( key );
		}
	} else if ( ev.target.matches( '.patch-remove' ) ) {
		await send( MSG.REMOVE_PATCH, { key } );
		render();
	} else if ( ev.target.matches( '.patch-refresh' ) ) {
		await send( MSG.REFRESH_PATCH, { key } );
		render();
	}
} );

el( 'patch-list' ).addEventListener( 'change', async ( ev ) => {
	const item = ev.target.closest( '.patch' );
	if ( !item ) {
		return;
	}
	const key = item.dataset.key;

	if ( ev.target.matches( '.patch-enabled' ) ) {
		await send( MSG.SET_PATCH_ENABLED, { key, value: ev.target.checked } );
		render();
	} else if ( ev.target.matches( '.patch-reviewed' ) ) {
		await send( MSG.REVIEW_PATCH, { key, value: ev.target.checked } );
		// Ticking the box is the decision to run the patch, so switch it on
		// too; a second click to do the obvious is a trap. Unticking stops it.
		await send( MSG.SET_PATCH_ENABLED, { key, value: ev.target.checked } );
		render();
	}
} );

el( 'open-options' ).addEventListener( 'click', ( ev ) => {
	ev.preventDefault();
	ext.runtime.openOptionsPage();
} );

render();
