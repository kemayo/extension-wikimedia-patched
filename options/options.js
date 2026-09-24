/**
 * Options: grant production wikis, and clear a stuck debug cookie.
 */

import { ext } from '../shared/webext.js';
import { MSG, PROD_WIKI_MATCHES } from '../shared/constants.js';

const list = document.getElementById( 'origins' );

async function send( type, extra = {} ) {
	const reply = await ext.runtime.sendMessage( { type, ...extra } );
	if ( !reply || !reply.ok ) {
		throw new Error( reply ? reply.error : 'The background worker did not answer.' );
	}
	return reply.result;
}

async function renderStrategy() {
	const { settings } = await send( MSG.GET_SETTINGS );
	for ( const input of document.querySelectorAll( 'input[name="debug-strategy"]' ) ) {
		input.checked = input.value === settings.debugStrategy;
		input.addEventListener( 'change', () => {
			if ( input.checked ) {
				send( MSG.SET_SETTING, { key: 'debugStrategy', value: input.value } );
			}
		} );
	}
}

async function render() {
	const granted = await ext.permissions.getAll();
	const have = new Set( granted.origins || [] );
	list.replaceChildren();

	for ( const pattern of PROD_WIKI_MATCHES ) {
		const li = document.createElement( 'li' );
		const label = document.createElement( 'label' );
		const box = document.createElement( 'input' );
		box.type = 'checkbox';
		box.checked = have.has( pattern );
		box.dataset.pattern = pattern;
		label.append( box, ' ', document.createTextNode( pattern ) );
		li.append( label );
		list.append( li );
	}
}

list.addEventListener( 'change', async ( ev ) => {
	const pattern = ev.target.dataset.pattern;
	if ( !pattern ) {
		return;
	}
	if ( ev.target.checked ) {
		const ok = await ext.permissions.request( { origins: [ pattern ] } );
		if ( !ok ) {
			ev.target.checked = false;
		}
	} else {
		await ext.permissions.remove( { origins: [ pattern ] } );
	}
	render();
} );

document.getElementById( 'clear-debug' ).addEventListener( 'click', async () => {
	const cookies = await ext.cookies.getAll( { name: 'resourceLoaderDebug' } );
	await Promise.all( cookies.map( ( c ) => ext.cookies.remove( {
		url: ( c.secure ? 'https://' : 'http://' ) + c.domain.replace( /^\./, '' ) + c.path,
		name: 'resourceLoaderDebug'
	} ).catch( () => {} ) ) );
	document.getElementById( 'clear-result' ).textContent =
		`Cleared ${ cookies.length } cookie(s).`;
} );

render();
renderStrategy();
