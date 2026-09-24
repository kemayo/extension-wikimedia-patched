/**
 * MAIN-world script. Runs at document_start, before the ResourceLoader
 * startup module.
 *
 * Phase 1 only opens the channel and collects the payload. Phase 2 adds the
 * message and style injection, and phase 3 adds the mw.loader.impl wrapper.
 */

( () => {
	// A random channel name so the page cannot guess it and inject data.
	const channel = 'wmp-' + Math.random().toString( 36 ).slice( 2 ) +
		Math.random().toString( 36 ).slice( 2 );
	document.documentElement.dataset.wmpChannel = channel;

	let payload = null;
	const waiting = [];

	document.addEventListener( channel + ':in', ( ev ) => {
		payload = ev.detail;
		// Remove the channel name so later page scripts cannot find it.
		delete document.documentElement.dataset.wmpChannel;
		for ( const fn of waiting.splice( 0 ) ) {
			fn( payload );
		}
	}, { once: true } );

	/** Run a callback once the patch data arrives. */
	function onPayload( fn ) {
		if ( payload ) {
			fn( payload );
		} else {
			waiting.push( fn );
		}
	}

	function report( files, siteNote ) {
		document.dispatchEvent( new CustomEvent( channel + ':out', {
			detail: { files, siteNote }
		} ) );
	}

	// TODO(phase 2): hook window.mw, set messages, disable the module store,
	// inject styles and new files.
	// TODO(phase 3): wrap mw.loader.impl and replace changed files.
	onPayload( ( data ) => {
		if ( !data.active ) {
			return;
		}
		report( [], 'WikimediaPatched is on, but no patch is applied yet.' );
	} );
} )();
