/**
 * Popup: the switch, the patch list, and what each patch did on this tab.
 */

import { ext } from '../shared/webext.js';
import { MSG, STATUS, GERRIT_BASE, optionalPatternFor } from '../shared/constants.js';

const el = ( id ) => document.getElementById( id );

/** How each result reads, and which colour class it gets. */
const STATUS_LABEL = {
	[ STATUS.APPLIED ]: [ 'applied', 's-good' ],
	[ STATUS.APPLIED_NEW ]: [ 'added', 's-good' ],
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

function renderPatch( patch, payload, report ) {
	const node = el( 'patch-template' ).content.firstElementChild.cloneNode( true );
	node.dataset.key = patch.key;
	node.classList.toggle( 'unreviewed', !patch.reviewed );

	const subject = node.querySelector( '.patch-subject' );
	subject.textContent = patch.subject || patch.key;
	subject.href = `${ GERRIT_BASE }/c/${ patch.project }/+/${ patch.changeNumber }/${ patch.patchset }`;

	node.querySelector( '.patch-meta' ).textContent =
		`${ patch.project } · PS${ patch.patchset } · ${ patch.owner }` +
		( patch.changeStatus === 'MERGED' ? ' · merged' : '' );

	const enabled = node.querySelector( '.patch-enabled' );
	enabled.checked = patch.enabled;
	enabled.disabled = !patch.reviewed;
	enabled.title = patch.reviewed ?
		'Apply this patch' :
		'Read the code first. Open the patch and tick the review box.';

	const reviewed = node.querySelector( '.patch-reviewed' );
	reviewed.checked = patch.reviewed;

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

	const note = el( 'site-note' );
	if ( report && report.siteNote ) {
		note.textContent = report.siteNote;
		note.hidden = false;
	} else {
		note.hidden = true;
	}

	renderElevatedWarning( report );

	const list = el( 'patch-list' );
	list.replaceChildren();
	el( 'empty' ).hidden = state.patches.length > 0;

	for ( const patch of state.patches ) {
		let payload = null;
		try {
			payload = ( await send( MSG.GET_PATCH_PAYLOAD, { key: patch.key } ) ).payload;
		} catch ( e ) {
			// A network problem must not empty the list.
		}
		list.append( renderPatch( patch, payload, report ) );
	}
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

el( 'add-form' ).addEventListener( 'submit', async ( ev ) => {
	ev.preventDefault();
	const input = el( 'add-input' );
	const error = el( 'add-error' );
	const button = el( 'add-button' );
	error.hidden = true;
	button.disabled = true;
	try {
		await send( MSG.ADD_PATCH, { input: input.value } );
		input.value = '';
		await render();
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

	if ( ev.target.matches( '.patch-expand' ) ) {
		const body = item.querySelector( '.patch-body' );
		body.hidden = !body.hidden;
		ev.target.textContent = body.hidden ? '▸' : '▾';
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
		// Turning review off must also stop the patch.
		if ( !ev.target.checked ) {
			await send( MSG.SET_PATCH_ENABLED, { key, value: false } );
		}
		render();
	}
} );

el( 'open-options' ).addEventListener( 'click', ( ev ) => {
	ev.preventDefault();
	ext.runtime.openOptionsPage();
} );

render();
