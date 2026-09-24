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

		chrome.runtime.sendMessage( { type: MSG_GET_PAYLOAD } )
			.then( ( reply ) => {
				send( reply && reply.ok ?
					reply.result :
					{ active: false, reason: 'error', patches: [] } );
			} )
			.catch( () => {
				send( { active: false, reason: 'no-worker', patches: [] } );
			} );

		document.addEventListener( channel + ':out', ( ev ) => {
			chrome.runtime.sendMessage( {
				type: MSG_REPORT_STATUS, report: ev.detail
			} ).catch( () => {} );
		} );
	} );
} )();
