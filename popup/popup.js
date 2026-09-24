/**
 * Popup: the switch, the patch list, and what each patch did on this tab.
 */

import { MSG, STATUS, GERRIT_BASE } from '../shared/constants.js';

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
	[ STATUS.BLOCKED_ELEVATED ]: [ 'needs confirming', 's-bad' ]
};

async function send( type, extra = {} ) {
	const reply = await chrome.runtime.sendMessage( { type, ...extra } );
	if ( !reply || !reply.ok ) {
		throw new Error( reply ? reply.error : 'The background worker did not answer.' );
	}
	return reply.result;
}

/** The report from the page, if the content script sent one. */
async function currentTabReport() {
	const [ tab ] = await chrome.tabs.query( { active: true, currentWindow: true } );
	if ( !tab ) {
		return { tab: null, report: null };
	}
	const { report } = await send( MSG.GET_TAB_STATUS, { tabId: tab.id } );
	return { tab, report };
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

	for ( const f of payload.replaceFiles ) {
		add( f.path, STATUS.NOT_ON_PAGE, 'No page loaded this file yet.' );
	}
	for ( const f of payload.newFiles ) {
		add( f.path, STATUS.NOT_ON_PAGE, 'No page loaded the owning module yet.' );
	}
	for ( const s of payload.styles ) {
		add( s.path, STATUS.NOT_ON_PAGE, 'Not injected on this page yet.' );
	}
	for ( const s of payload.skipped ) {
		rows.push( { path: s.path, status: s.status, reason: s.reason } );
	}
	if ( Object.keys( payload.messages ).length ) {
		const count = Object.keys( payload.messages ).length;
		const live = fromPage.get( '(messages)' );
		rows.push( live || {
			path: '(messages)',
			status: STATUS.NOT_ON_PAGE,
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
	const [ state, { report } ] = await Promise.all( [
		send( MSG.GET_STATE ), currentTabReport()
	] );

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

el( 'elevated-ack' ).addEventListener( 'click', async () => {
	const [ tab ] = await chrome.tabs.query( { active: true, currentWindow: true } );
	if ( !tab || !tab.url ) {
		return;
	}
	await send( MSG.ACK_ELEVATED, { origin: new URL( tab.url ).origin } );
	await chrome.tabs.reload( tab.id );
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
	chrome.runtime.openOptionsPage();
} );

render();
