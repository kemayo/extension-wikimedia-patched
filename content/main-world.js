/**
 * MAIN-world script. Runs at document_start, before the ResourceLoader
 * startup module.
 *
 * It hooks three things, each one before the page creates it:
 *   window.mw       to set patch messages before any module runs
 *   mw.loader       to turn off the module store
 *   mw.loader.impl  to see each module as it arrives
 *
 * The store must be off. Core keeps a module by calling String() on the
 * declarator and writing it to localStorage. A wrapped declarator does not
 * survive that, and a stored copy would keep running after the user turns
 * the extension off.
 *
 * Nothing here may throw into the page. A throw inside the impl wrapper
 * stops the rest of that load.php response, and every later module in the
 * same response stays in state "loading" for ever, with no error.
 */

( () => {
	'use strict';

	// @include shared/constants.js
	// @include shared/resolve-module.js
	// @include shared/verify-base.js

	// ---------------------------------------------------------------- channel

	const channel = 'wmp-' + Math.random().toString( 36 ).slice( 2 ) +
		Math.random().toString( 36 ).slice( 2 );
	document.documentElement.dataset.wmpChannel = channel;

	let payload = null;
	let payloadSettled = false;
	const payloadWaiters = [];

	function settlePayload( data ) {
		if ( payloadSettled ) {
			return;
		}
		payloadSettled = true;
		payload = data;
		delete document.documentElement.dataset.wmpChannel;
		for ( const fn of payloadWaiters.splice( 0 ) ) {
			safely( fn, data );
		}
	}

	function onPayload( fn ) {
		if ( payloadSettled ) {
			safely( fn, payload );
		} else {
			payloadWaiters.push( fn );
		}
	}

	document.addEventListener( channel + ':in', ( ev ) => settlePayload( ev.detail ),
		{ once: true } );

	// If the bridge never answers, carry on without patches.
	setTimeout( () => settlePayload( {
		active: false, reason: 'timed-out', patches: []
	} ), IMPL_BUFFER_TIMEOUT_MS );

	/** Run a function and swallow anything it throws. */
	function safely( fn, ...args ) {
		try {
			return fn( ...args );
		} catch ( e ) {
			try {
				// eslint-disable-next-line no-console
				console.warn( '[WikimediaPatched]', e );
			} catch ( e2 ) {}
			return undefined;
		}
	}

	// ---------------------------------------------------------------- results

	/** One row for each file, so nothing fails silently. */
	const results = [];
	const reported = new Set();
	let reportTimer = null;
	let siteNote = null;

	function record( patchKey, path, status, reason ) {
		const id = patchKey + '\u0000' + path;
		if ( reported.has( id ) ) {
			return;
		}
		reported.add( id );
		results.push( { patchKey, path, status, reason: reason || '' } );
		scheduleReport();
	}

	function scheduleReport() {
		if ( reportTimer ) {
			return;
		}
		reportTimer = setTimeout( () => {
			reportTimer = null;
			document.dispatchEvent( new CustomEvent( channel + ':out', {
				detail: { files: results.slice(), siteNote }
			} ) );
		}, 50 );
	}

	// ------------------------------------------------------------ page guards

	/**
	 * Decide whether the extension may touch this page.
	 *
	 * mw.config is filled by an inline script, so this can only run once a
	 * module is about to execute.
	 *
	 * @param {Object} mw
	 * @return {{ ok: boolean, status: string|null, reason: string|null }}
	 */
	function checkPage( mw ) {
		if ( !mw.config || typeof mw.config.get !== 'function' ) {
			return { ok: true, status: null, reason: null };
		}
		const special = mw.config.get( 'wgCanonicalSpecialPageName' );
		if ( special && BLOCKED_SPECIAL_PAGES.includes( special ) ) {
			return {
				ok: false, status: STATUS.BLOCKED_PAGE,
				reason: `Special:${ special } handles credentials. No patch runs here.`
			};
		}
		const groups = mw.config.get( 'wgUserGroups' ) || [];
		const elevated = groups.filter( ( g ) => ELEVATED_GROUPS.includes( g ) );
		if ( elevated.length && !( payload && payload.elevatedAck ) ) {
			return {
				ok: false, status: STATUS.BLOCKED_ELEVATED,
				reason: `Your account has ${ elevated.join( ', ' ) }. ` +
					'Confirm in the extension popup before a patch runs.'
			};
		}
		return { ok: true, status: null, reason: null };
	}

	// ------------------------------------------------------------- injections

	let messagesDone = false;

	/** Install the English messages the patch adds. */
	function applyMessages( mw ) {
		if ( !payload || !payload.active ) {
			return;
		}
		let count = 0;
		for ( const patch of payload.patches ) {
			const keys = Object.keys( patch.messages || {} );
			if ( !keys.length ) {
				continue;
			}
			mw.messages.set( patch.messages );
			count += keys.length;
			if ( !messagesDone ) {
				record( patch.key, '(messages)', STATUS.APPLIED,
					`${ keys.length } English message(s) set.` );
			}
		}
		messagesDone = count > 0 || messagesDone;
	}

	/**
	 * Add the patch stylesheets.
	 *
	 * The style element is moved to the end of the head each time a module
	 * runs, so a patch rule keeps beating the rule it replaces.
	 */
	let styleEl = null;

	function applyStyles() {
		if ( !payload || !payload.active ) {
			return;
		}
		const parts = [];
		for ( const patch of payload.patches ) {
			for ( const style of patch.styles || [] ) {
				parts.push( `/* ${ patch.key } ${ style.path } */\n${ style.css }` );
				record( patch.key, style.path, STATUS.STYLE_INJECTED,
					'Injected as a style element.' );
			}
		}
		if ( !parts.length ) {
			return;
		}
		if ( !styleEl ) {
			styleEl = document.createElement( 'style' );
			styleEl.id = 'wikimedia-patched-styles';
			styleEl.textContent = parts.join( '\n\n' );
		}
		moveStylesLast();
	}

	function moveStylesLast() {
		if ( !styleEl ) {
			return;
		}
		const parent = document.head || document.documentElement;
		// appendChild moves an element that is already in the tree.
		if ( parent && parent.lastChild !== styleEl ) {
			parent.appendChild( styleEl );
		}
	}

	/**
	 * Build a require() that behaves like the one ResourceLoader gives a
	 * packaged file.
	 *
	 * @param {Object} mw
	 * @param {Object} moduleObj Entry from mw.loader.moduleRegistry.
	 * @param {string} basePath Key of the requiring file.
	 * @return {Function}
	 */
	function makeRequire( mw, moduleObj, basePath ) {
		return function require( name ) {
			const fileName = resolveRelativePath( name, basePath );
			if ( fileName === null ) {
				return mw.loader.require( name );
			}
			if ( Object.prototype.hasOwnProperty.call( moduleObj.packageExports, fileName ) ) {
				return moduleObj.packageExports[ fileName ];
			}
			const files = moduleObj.script && moduleObj.script.files;
			if ( !files || !Object.prototype.hasOwnProperty.call( files, fileName ) ) {
				throw new Error( 'Cannot require undefined file ' + fileName );
			}
			const content = files[ fileName ];
			let result;
			if ( typeof content === 'function' ) {
				const param = { exports: {} };
				content( makeRequire( mw, moduleObj, fileName ), param, param.exports );
				result = param.exports;
			} else {
				result = content;
			}
			moduleObj.packageExports[ fileName ] = result;
			return result;
		};
	}

	/**
	 * Run one added file inside a module.
	 *
	 * @param {Object} mw
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {{ module: string, key: string }} target
	 */
	function runNewFile( mw, patch, file, target ) {
		const moduleObj = mw.loader.moduleRegistry[ target.module ];
		if ( !moduleObj ) {
			record( patch.key, file.path, STATUS.NOT_ON_PAGE,
				`Module ${ target.module } is not registered.` );
			return;
		}

		const factory = compileFile( patch, file );

		// Let other files in the module require this one.
		if ( moduleObj.script && moduleObj.script.files &&
			!Object.prototype.hasOwnProperty.call( moduleObj.script.files, target.key ) ) {
			moduleObj.script.files[ target.key ] = factory;
		}

		const param = { exports: {} };
		factory( makeRequire( mw, moduleObj, target.key ), param, param.exports );
		moduleObj.packageExports[ target.key ] = param.exports;

		record( patch.key, file.path, STATUS.APPLIED_NEW,
			`Added to ${ target.module } as ${ target.key }.` );
	}

	// -------------------------------------------------------------- rewriting

	/**
	 * Compile one patched file into the shape ResourceLoader uses.
	 *
	 * The sourceURL comment makes the file show up by name in the debugger,
	 * instead of as an anonymous eval.
	 *
	 * @param {Object} patch
	 * @param {Object} file
	 * @return {Function}
	 */
	function compileFile( patch, file ) {
		const sourceUrl = `wikimedia-patched://${ patch.changeNumber }/${ file.path }`;
		return new Function( 'require', 'module', 'exports',
			file.source + '\n//# sourceURL=' + sourceUrl + '\n' );
	}

	/**
	 * Put a changed file into the payload, in place of the deployed one.
	 *
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {Object} script The payload's script object.
	 * @param {string} key
	 * @param {string} moduleName
	 */
	function replaceFileInPayload( patch, file, script, key, moduleName ) {
		const verdict = compareBase( script.files[ key ], file.parentSource );
		script.files[ key ] = compileFile( patch, file );

		if ( verdict === 'differs' ) {
			record( patch.key, file.path, STATUS.BASE_SKEW,
				`Replaced in ${ moduleName }. The wiki runs a different version of ` +
				'this file, so the patch may not fit.' );
		} else if ( verdict === 'match' ) {
			record( patch.key, file.path, STATUS.APPLIED,
				`Replaced in ${ moduleName }. The wiki runs the patch base.` );
		} else {
			record( patch.key, file.path, STATUS.APPLIED,
				`Replaced in ${ moduleName }. The base was not checked, because the ` +
				'page is not in debug mode.' );
		}
	}

	/**
	 * Add a new file to the payload, and make the module's main file load it.
	 *
	 * ResourceLoader runs only what the main file requires, so a file that
	 * nothing requires would never run.
	 *
	 * @param {Object} patch
	 * @param {Object} file
	 * @param {Object} script
	 * @param {string} key
	 * @param {string} moduleName
	 */
	function insertFileInPayload( patch, file, script, key, moduleName ) {
		script.files[ key ] = compileFile( patch, file );

		const main = script.main;
		if ( main && main !== key && typeof script.files[ main ] === 'function' ) {
			const originalMain = script.files[ main ];
			const relative = relativeRequirePath( main, key );
			script.files[ main ] = function ( require, module, exports ) {
				const result = originalMain( require, module, exports );
				// require() caches, so this is safe even if main already asked.
				require( relative );
				return result;
			};
		}
		record( patch.key, file.path, STATUS.APPLIED_NEW,
			`Added to ${ moduleName } as ${ key }.` );
	}

	/**
	 * Change a module payload before the page runs it.
	 *
	 * This is the only moment the extension can replace a file. Once the
	 * module runs, its code is in effect and re-running it would repeat
	 * every side effect.
	 *
	 * @param {Object} mw
	 * @param {string} name
	 * @param {Array} data The array the declarator returned.
	 */
	function rewriteModulePayload( mw, name, data ) {
		if ( !payload || !payload.active ) {
			return;
		}
		const guard = checkPage( mw );
		if ( !guard.ok ) {
			for ( const patch of payload.patches ) {
				record( patch.key, '(page)', guard.status, guard.reason );
			}
			return;
		}

		const script = data[ 1 ];
		if ( !script || typeof script !== 'object' || !script.files ) {
			// A scripts-only module is one blob. There is no way to tell
			// which part came from which file.
			if ( script ) {
				legacyModules.push( name );
			}
			return;
		}

		const entry = { name, files: Object.keys( script.files ) };

		// Replace first, so a new main file is in place before it is wrapped.
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const hit = matchFileToModule( file.path, [ entry ] );
				if ( hit.status !== 'exact' && hit.status !== 'suffix' ) {
					continue;
				}
				const key = hit.matches[ 0 ].key;
				safely( replaceFileInPayload, patch, file, script, key, name );
				anchors.push( { repoPath: file.path, module: name, key } );
			}
		}

		const known = seenModules.concat( [ entry ] );
		for ( const patch of payload.patches ) {
			for ( const file of patch.newFiles || [] ) {
				if ( insertedNewFiles.has( file ) ) {
					continue;
				}
				const target = inferModuleForNewFile(
					file.path, file.siblings || [], known, anchors
				);
				if ( target.module !== name ) {
					continue;
				}
				insertedNewFiles.add( file );
				safely( insertFileInPayload, patch, file, script, target.key, name );
			}
		}
	}

	// ------------------------------------------------------- module bookkeeping

	/** Modules seen on this page: name to the keys of its packaged files. */
	const seenModules = [];
	/** Files of the patch that are already placed, used to place new files. */
	const anchors = [];
	/** New files still waiting for their module. */
	const pendingNewFiles = [];
	/** New files already put into a module payload. */
	const insertedNewFiles = new Set();
	/** Modules that do not use packageFiles, so the extension cannot see inside. */
	const legacyModules = [];

	function moduleEntry( name, script ) {
		const files = script && typeof script === 'object' && script.files ?
			Object.keys( script.files ) : [];
		return { name, files };
	}

	/**
	 * A module arrived. Note what it holds, and place any new file that
	 * belongs to it.
	 *
	 * @param {Object} mw
	 * @param {string} name
	 * @param {Array} data The array the declarator returned.
	 */
	function onModule( mw, name, data ) {
		const entry = moduleEntry( name, data[ 1 ] );
		seenModules.push( entry );
		considerModule( mw, entry );
	}

	/**
	 * Act on a module the page loaded.
	 *
	 * A module can arrive before the bridge answers, so this also runs
	 * again for every module already seen once the payload is in.
	 *
	 * @param {Object} mw
	 * @param {{ name: string, files: string[] }} entry
	 */
	function considerModule( mw, entry ) {
		if ( !payload || !payload.active ) {
			return;
		}

		const guard = checkPage( mw );
		if ( !guard.ok ) {
			for ( const patch of payload.patches ) {
				record( patch.key, '(page)', guard.status, guard.reason );
			}
			return;
		}

		// Note which changed files this module holds. Phase 3 replaces them.
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const hit = matchFileToModule( file.path, [ entry ] );
				if ( hit.status === 'exact' || hit.status === 'suffix' ) {
					anchors.push( {
						repoPath: file.path,
						module: hit.matches[ 0 ].module,
						key: hit.matches[ 0 ].key
					} );
				}
			}
			for ( const file of patch.newFiles || [] ) {
				if ( insertedNewFiles.has( file ) ) {
					continue;
				}
				if ( !pendingNewFiles.some( ( p ) => p.file === file ) ) {
					pendingNewFiles.push( { patch, file } );
				}
			}
		}

		placePendingFiles( mw );
		moveStylesLast();
	}

	/** Try to place every added file that is still waiting. */
	function placePendingFiles( mw ) {
		for ( let i = pendingNewFiles.length - 1; i >= 0; i-- ) {
			const { patch, file } = pendingNewFiles[ i ];
			if ( insertedNewFiles.has( file ) ) {
				pendingNewFiles.splice( i, 1 );
				continue;
			}
			const target = inferModuleForNewFile(
				file.path, file.siblings || [], seenModules, anchors
			);
			if ( target.status === 'none' ) {
				continue;
			}
			if ( target.status === 'ambiguous' ) {
				pendingNewFiles.splice( i, 1 );
				record( patch.key, file.path, STATUS.AMBIGUOUS,
					'Could be ' + target.candidates.map( ( c ) => c.module ).join( ' or ' ) + '.' );
				continue;
			}
			pendingNewFiles.splice( i, 1 );
			// The module must finish before its own file can run.
			mw.loader.using( target.module ).then( () => {
				// Messages may have been overwritten while the module ran.
				safely( applyMessages, mw );
				safely( runNewFile, mw, patch, file, target );
				safely( moveStylesLast );
			}, () => {
				record( patch.key, file.path, STATUS.NOT_ON_PAGE,
					`Module ${ target.module } failed to load.` );
			} );
		}
	}

	/** Say what never found a home, once the page has settled. */
	function reportLeftovers() {
		if ( !payload || !payload.active ) {
			return;
		}
		for ( const { patch, file } of pendingNewFiles ) {
			record( patch.key, file.path, STATUS.NOT_ON_PAGE,
				file.siblingsUnknown ?
					'Gerrit would not list this directory, so the extension ' +
						'cannot tell which module owns the file. Try again later.' :
					'No module on this page owns this directory.' );
		}
		for ( const patch of payload.patches ) {
			for ( const file of patch.replaceFiles || [] ) {
				const hit = matchFileToModule( file.path, seenModules );
				if ( hit.status === 'none' ) {
					record( patch.key, file.path, STATUS.NOT_ON_PAGE,
						'No module on this page holds this file.' + ( legacyModules.length ?
							' Some modules here do not use packageFiles, and the ' +
							'extension cannot see inside those.' : '' ) );
				} else if ( hit.status === 'ambiguous' ) {
					record( patch.key, file.path, STATUS.AMBIGUOUS,
						'Could be ' + hit.matches.map( ( m ) => m.module ).join( ' or ' ) + '.' );
				} else {
					// The module arrived before the extension was ready, so
					// its payload could not be changed.
					record( patch.key, file.path, STATUS.TIMED_OUT,
						`Found in ${ hit.matches[ 0 ].module }, but that module loaded ` +
						'before the extension was ready. Reload the page.' );
				}
			}
			for ( const skipped of patch.skipped || [] ) {
				record( patch.key, skipped.path, skipped.status, skipped.reason );
			}
		}
	}

	// ------------------------------------------------------------------ hooks

	/**
	 * Watch for a property the page has not created yet.
	 *
	 * The accessor replaces itself with a plain value as soon as it fires,
	 * so nothing downstream sees an unusual property.
	 *
	 * @param {Object} obj
	 * @param {string} prop
	 * @param {function(*)} onSet
	 */
	function defineOnce( obj, prop, onSet ) {
		const existing = obj[ prop ];
		if ( existing !== undefined ) {
			safely( onSet, existing );
			return;
		}
		let stored;
		try {
			Object.defineProperty( obj, prop, {
				configurable: true,
				enumerable: true,
				get() {
					return stored;
				},
				set( value ) {
					stored = value;
					Object.defineProperty( obj, prop, {
						value, writable: true, configurable: true, enumerable: true
					} );
					safely( onSet, value );
				}
			} );
		} catch ( e ) {
			// The page made the property first, or made it read-only.
			safely( onSet, obj[ prop ] );
		}
	}

	function onLoader( mw, loader ) {
		// Stop the module store before init() reads localStorage. init() only
		// acts while enabled is null.
		defineOnce( loader, 'store', ( store ) => {
			store.enabled = false;
		} );

		const originalImpl = loader.impl;
		if ( typeof originalImpl !== 'function' ) {
			return;
		}

		loader.impl = function ( declarator ) {
			// Anything that throws here loses every later module in the same
			// response, so the original call is always the fallback.
			let data;
			try {
				data = declarator();
			} catch ( e ) {
				return originalImpl.apply( this, arguments );
			}

			let name;
			try {
				name = String( data[ 0 ] ).split( '@' )[ 0 ];
			} catch ( e ) {
				return originalImpl.apply( this, arguments );
			}

			safely( rewriteModulePayload, mw, name, data );

			let result;
			try {
				result = originalImpl.call( this, () => data );
			} catch ( e ) {
				// The payload is unchanged, so a failure is the page's own.
				throw e;
			}

			if ( !BASE_MODULES.includes( name ) ) {
				safely( onModule, mw, name, data );
			}
			return result;
		};
	}

	function onMw( mw ) {
		onPayload( () => {
			safely( applyMessages, mw );
			safely( applyStyles );
			// Some modules may already be here. Look at them again now that
			// the extension knows what to do.
			for ( const entry of seenModules.slice() ) {
				safely( considerModule, mw, entry );
			}
		} );
		defineOnce( mw, 'loader', ( loader ) => onLoader( mw, loader ) );
	}

	defineOnce( window, 'mw', onMw );

	// ----------------------------------------------------------------- finish

	/**
	 * Say whether the page really is in debug mode.
	 *
	 * The startup module sets maxQueryLength to 0 only in debug mode, so
	 * that one value is the signal. Without debug mode the extension still
	 * applies a patch, but it cannot check the patch base against the code
	 * the wiki runs.
	 *
	 * @param {Object} mw
	 * @return {boolean}
	 */
	function inDebugMode( mw ) {
		return !!( mw && mw.loader && mw.loader.maxQueryLength === 0 );
	}

	function finish() {
		safely( applyStyles );
		safely( moveStylesLast );
		safely( reportLeftovers );
		if ( payload && payload.active ) {
			const count = payload.patches.length;
			const where = payload.siteKind === 'prod' ? 'a production wiki' : 'a test wiki';
			const debug = inDebugMode( window.mw ) ?
				'' :
				' Debug mode is off, so the patch base is not checked. Reload the page.';
			siteNote = `${ count } patch(es) active on ${ where }.${ debug }`;
			scheduleReport();
		}
	}

	onPayload( () => {
		if ( document.readyState === 'complete' ) {
			setTimeout( finish, 1500 );
		} else {
			window.addEventListener( 'load', () => setTimeout( finish, 1500 ), { once: true } );
		}
	} );
} )();
