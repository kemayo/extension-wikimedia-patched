/**
 * Isolated-world bridge.
 *
 * The page cannot talk to the background worker, and the MAIN-world script
 * shares the page's globals. So this script sits between them.
 *
 * Transport is a CustomEvent on a random name that the MAIN-world script
 * makes. window.postMessage would let the page read the patch data and send
 * fake data back.
 *
 * Content scripts cannot be ES modules, so the message names are literals.
 * Keep them the same as MSG in shared/constants.js.
 */

( () => {
	// Firefox promises live on `browser`; Chrome's are on `chrome`.
	const ext = globalThis.browser || globalThis.chrome;

	const MSG_GET_PAYLOAD = 'get-payload';
	const MSG_REPORT_STATUS = 'report-status';

	/**
	 * Both content scripts run at document_start, but the browser does not
	 * promise that the MAIN-world one runs first. So wait for the channel
	 * instead of reading it once.
	 *
	 * @param {function(string)} fn
	 */
	function whenChannelReady( fn ) {
		const read = () => document.documentElement &&
			document.documentElement.dataset.wmpChannel;

		const now = read();
		if ( now ) {
			fn( now );
			return;
		}
		const observer = new MutationObserver( () => {
			const channel = read();
			if ( channel ) {
				observer.disconnect();
				clearTimeout( timer );
				fn( channel );
			}
		} );
		observer.observe( document.documentElement, {
			attributes: true, attributeFilter: [ 'data-wmp-channel' ]
		} );
		// If the MAIN-world script never ran, stop watching.
		const timer = setTimeout( () => observer.disconnect(), 5000 );
	}

	whenChannelReady( ( channel ) => {
		const send = ( detail ) => {
			document.dispatchEvent( new CustomEvent( channel + ':in', { detail } ) );
		};

		ext.runtime.sendMessage( { type: MSG_GET_PAYLOAD } )
			.then( ( reply ) => {
				const result = reply && reply.ok ?
					reply.result :
					{ active: false, reason: 'error', patches: [] };
				send( result );
				if ( result.active && result.patches.length ) {
					showBanner( result.patches );
				}
			} )
			.catch( () => {
				send( { active: false, reason: 'no-worker', patches: [] } );
			} );

		document.addEventListener( channel + ':out', ( ev ) => {
			ext.runtime.sendMessage( {
				type: MSG_REPORT_STATUS, report: ev.detail
			} ).catch( () => {} );
		} );
	} );

	/**
	 * Show a bar while a patch is active.
	 *
	 * The bar cannot be closed. A user must always be able to see that the
	 * page is not running the deployed code.
	 *
	 * @param {Object[]} patches
	 */
	function showBanner( patches ) {
		const host = document.createElement( 'div' );
		host.id = 'wikimedia-patched-banner';
		const root = host.attachShadow( { mode: 'closed' } );

		const style = document.createElement( 'style' );
		style.textContent = `
			.bar {
				position: fixed; left: 0; bottom: 0; z-index: 2147483647;
				max-width: 46ch; padding: 6px 10px;
				font: 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
				color: #fff; background: #ac6600;
				border-top-right-radius: 3px;
				box-shadow: 0 0 6px rgba( 0, 0, 0, 0.4 );
			}
			.bar b { font-weight: 700; }
			.bar a { color: #fff; }
		`;

		const bar = document.createElement( 'div' );
		bar.className = 'bar';
		const label = document.createElement( 'b' );
		label.textContent = 'Patched: ';
		bar.append( label );
		patches.forEach( ( patch, i ) => {
			if ( i ) {
				bar.append( document.createTextNode( ', ' ) );
			}
			const link = document.createElement( 'a' );
			link.href = `https://gerrit.wikimedia.org/r/c/${ patch.project }/+/` +
				`${ patch.changeNumber }/${ patch.patchset }`;
			link.target = '_blank';
			link.rel = 'noreferrer';
			link.textContent = `${ patch.changeNumber } PS${ patch.patchset }`;
			bar.append( link );
		} );

		root.append( style, bar );

		const attach = () => ( document.body || document.documentElement ).append( host );
		if ( document.body ) {
			attach();
		} else {
			document.addEventListener( 'DOMContentLoaded', attach, { once: true } );
		}
	}
} )();
