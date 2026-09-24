#!/usr/bin/env node
/**
 * Write the updates.json that Firefox reads to update a self-hosted add-on.
 *
 * Run by the release workflow once the XPI is signed:
 *   node scripts/firefox-updates.mjs <xpi> <download-url> <out>
 * The add-on id and version come from the built Firefox manifest, so they
 * cannot disagree with the XPI.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The update manifest for one version.
 *
 * Only the newest version is listed: Firefox takes the highest version it
 * can use, so older entries add nothing.
 *
 * @param {{ id: string, version: string, link: string, hash: string }} opts
 * @return {Object}
 */
export function buildUpdateManifest( { id, version, link, hash } ) {
	if ( !/^https:\/\//.test( link ) ) {
		throw new Error( `Firefox updates only from https, not ${ link }` );
	}
	return {
		addons: {
			[ id ]: {
				updates: [
					{ version, update_link: link, update_hash: `sha256:${ hash }` }
				]
			}
		}
	};
}

if ( process.argv[ 1 ] === fileURLToPath( import.meta.url ) ) {
	const [ xpi, link, out ] = process.argv.slice( 2 );
	if ( !xpi || !link || !out ) {
		console.error( 'usage: firefox-updates.mjs <xpi> <download-url> <out>' );
		process.exit( 1 );
	}
	const manifest = JSON.parse( readFileSync( 'dist/firefox/manifest.json', 'utf8' ) );
	const json = buildUpdateManifest( {
		id: manifest.browser_specific_settings.gecko.id,
		version: manifest.version,
		link,
		hash: createHash( 'sha256' ).update( readFileSync( xpi ) ).digest( 'hex' )
	} );
	writeFileSync( out, JSON.stringify( json, null, '\t' ) + '\n' );
	console.log( `wrote ${ out } for ${ manifest.version }` );
}
