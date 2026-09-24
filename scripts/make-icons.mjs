#!/usr/bin/env node
/**
 * Draw the toolbar icons: a rounded square with two bars, like the two
 * lines of a diff.
 *
 * The "off" set is the same drawing, desaturated, so a glance at the
 * toolbar says whether the switch is on. Run with: node scripts/make-icons.mjs
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const ON = [ 0x14, 0x86, 0x6d ];
// The same colour at the same luminance, without saturation.
const luma = Math.round( 0.299 * ON[ 0 ] + 0.587 * ON[ 1 ] + 0.114 * ON[ 2 ] );
const OFF = [ luma, luma, luma ];
const BAR = [ 0xff, 0xff, 0xff ];

function crc32( buf ) {
	let c = ~0;
	for ( const byte of buf ) {
		c ^= byte;
		for ( let k = 0; k < 8; k++ ) {
			c = ( c >>> 1 ) ^ ( 0xedb88320 & -( c & 1 ) );
		}
	}
	return ~c >>> 0;
}

function chunk( tag, data ) {
	const len = Buffer.alloc( 4 );
	len.writeUInt32BE( data.length );
	const body = Buffer.concat( [ Buffer.from( tag ), data ] );
	const crc = Buffer.alloc( 4 );
	crc.writeUInt32BE( crc32( body ) );
	return Buffer.concat( [ len, body, crc ] );
}

function png( size, bg ) {
	const r = Math.max( 1, Math.floor( size / 8 ) );
	const barH = Math.max( 2, Math.floor( size / 6 ) );
	const gap = Math.max( 1, Math.floor( size / 16 ) );
	const inset = Math.max( 2, Math.floor( size / 5 ) );
	const top = Math.floor( size / 2 ) - barH - gap;
	const bottom = Math.floor( size / 2 ) + gap;

	const rows = [];
	for ( let y = 0; y < size; y++ ) {
		const row = [ 0 ];
		for ( let x = 0; x < size; x++ ) {
			const cx = Math.min( x, size - 1 - x );
			const cy = Math.min( y, size - 1 - y );
			if ( cx < r && cy < r && ( r - cx ) ** 2 + ( r - cy ) ** 2 > r * r ) {
				row.push( 0, 0, 0, 0 );
				continue;
			}
			const inTop = y >= top && y < top + barH && x >= inset && x < size - inset;
			const inBottom = y >= bottom && y < bottom + barH &&
				x >= inset && x < size - inset - barH;
			row.push( ...( inTop || inBottom ? BAR : bg ), 255 );
		}
		rows.push( Buffer.from( row ) );
	}
	const header = Buffer.alloc( 13 );
	header.writeUInt32BE( size, 0 );
	header.writeUInt32BE( size, 4 );
	header.set( [ 8, 6, 0, 0, 0 ], 8 );
	return Buffer.concat( [
		Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ),
		chunk( 'IHDR', header ),
		chunk( 'IDAT', deflateSync( Buffer.concat( rows ), { level: 9 } ) ),
		chunk( 'IEND', Buffer.alloc( 0 ) )
	] );
}

for ( const size of [ 16, 32, 48, 128 ] ) {
	writeFileSync( `icons/icon-${ size }.png`, png( size, ON ) );
	writeFileSync( `icons/icon-off-${ size }.png`, png( size, OFF ) );
}
console.log( `drew icons; off colour is #${ luma.toString( 16 ).repeat( 3 ) }` );
