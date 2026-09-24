/**
 * Options: grant production wikis, and clear a stuck debug cookie.
 */

import { PROD_WIKI_MATCHES } from '../shared/constants.js';

const list = document.getElementById( 'origins' );

async function render() {
	const granted = await chrome.permissions.getAll();
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
		const ok = await chrome.permissions.request( { origins: [ pattern ] } );
		if ( !ok ) {
			ev.target.checked = false;
		}
	} else {
		await chrome.permissions.remove( { origins: [ pattern ] } );
	}
	render();
} );

document.getElementById( 'clear-debug' ).addEventListener( 'click', async () => {
	const cookies = await chrome.cookies.getAll( { name: 'resourceLoaderDebug' } );
	await Promise.all( cookies.map( ( c ) => chrome.cookies.remove( {
		url: ( c.secure ? 'https://' : 'http://' ) + c.domain.replace( /^\./, '' ) + c.path,
		name: 'resourceLoaderDebug'
	} ).catch( () => {} ) ) );
	document.getElementById( 'clear-result' ).textContent =
		`Cleared ${ cookies.length } cookie(s).`;
} );

render();
