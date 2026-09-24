/**
 * Line-based diff and three-way merge.
 *
 * Replacing a whole file brings along everything between the patch's base
 * and what the wiki runs: master changes the wiki never got, and the
 * reverse of any backport the wiki has. A three-way merge applies only the
 * patch's own changes to the wiki's copy of the file.
 *
 * The merge is conservative. Changes that touch or sit next to each other
 * count as a conflict, the way diff3 treats them. A false conflict only
 * means the caller falls back to replacing the file with a warning. A false
 * clean merge would produce broken code without a word.
 */

/** Past this many edits the files are too far apart for a merge to mean much. */
const MAX_EDITS = 2000;

function splitLines( text ) {
	return String( text ).replace( /\r\n?/g, '\n' ).split( '\n' );
}

/**
 * Find the longest common subsequence of two line arrays, with Myers' O(ND)
 * algorithm. Fast when the files are close, which is the normal case.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} limit Give up after this many edits.
 * @return {Array<[number, number]>|null} Matched index pairs, in order.
 */
function myers( a, b, limit ) {
	const n = a.length;
	const m = b.length;
	const max = Math.min( n + m, limit );
	const offset = max + 1;
	const v = new Int32Array( 2 * max + 3 );
	v[ offset + 1 ] = 0;
	const trace = [];

	let found = false;
	for ( let d = 0; d <= max && !found; d++ ) {
		trace.push( v.slice() );
		for ( let k = -d; k <= d; k += 2 ) {
			let x;
			if ( k === -d || ( k !== d && v[ offset + k - 1 ] < v[ offset + k + 1 ] ) ) {
				x = v[ offset + k + 1 ];
			} else {
				x = v[ offset + k - 1 ] + 1;
			}
			let y = x - k;
			while ( x < n && y < m && a[ x ] === b[ y ] ) {
				x++;
				y++;
			}
			v[ offset + k ] = x;
			if ( x >= n && y >= m ) {
				found = true;
				break;
			}
		}
	}
	if ( !found ) {
		return null;
	}

	// Walk back through the trace to recover the matched lines.
	const matches = [];
	let x = n;
	let y = m;
	for ( let d = trace.length - 1; d >= 0; d-- ) {
		const vd = trace[ d ];
		const k = x - y;
		let prevK;
		if ( k === -d || ( k !== d && vd[ offset + k - 1 ] < vd[ offset + k + 1 ] ) ) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = vd[ offset + prevK ];
		const prevY = prevX - prevK;
		while ( x > prevX && y > prevY ) {
			matches.push( [ x - 1, y - 1 ] );
			x--;
			y--;
		}
		x = prevX;
		y = prevY;
	}
	return matches.reverse();
}

/**
 * Describe how to turn one list of lines into another.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @return {Array<{ aStart: number, aEnd: number, bStart: number, bEnd: number }>|null}
 *   Half-open ranges: a[aStart, aEnd) becomes b[bStart, bEnd). Null when the
 *   inputs are too different to compare.
 */
export function diffLines( a, b ) {
	// The common start and end are most of any real file, so take them off
	// before the expensive part.
	let pre = 0;
	while ( pre < a.length && pre < b.length && a[ pre ] === b[ pre ] ) {
		pre++;
	}
	let suf = 0;
	while ( suf < a.length - pre && suf < b.length - pre &&
		a[ a.length - 1 - suf ] === b[ b.length - 1 - suf ] ) {
		suf++;
	}
	const midA = a.slice( pre, a.length - suf );
	const midB = b.slice( pre, b.length - suf );

	const matches = myers( midA, midB, MAX_EDITS );
	if ( matches === null ) {
		return null;
	}

	const hunks = [];
	let i = 0;
	let j = 0;
	for ( const [ mi, mj ] of [ ...matches, [ midA.length, midB.length ] ] ) {
		if ( mi > i || mj > j ) {
			hunks.push( { aStart: i + pre, aEnd: mi + pre, bStart: j + pre, bEnd: mj + pre } );
		}
		i = mi + 1;
		j = mj + 1;
	}
	return hunks;
}

/**
 * Apply the hunks of one side to a slice of the base.
 *
 * @param {string[]} base
 * @param {string[]} side
 * @param {Array} hunks Hunks from diffLines( base, side ), all inside the slice.
 * @param {number} start
 * @param {number} end
 * @return {string[]}
 */
function applyHunks( base, side, hunks, start, end ) {
	const out = [];
	let pos = start;
	for ( const h of hunks ) {
		out.push( ...base.slice( pos, h.aStart ) );
		out.push( ...side.slice( h.bStart, h.bEnd ) );
		pos = h.aEnd;
	}
	out.push( ...base.slice( pos, end ) );
	return out;
}

/**
 * Merge two sets of changes to one base.
 *
 * @param {string} baseText What the patch was written against.
 * @param {string} oursText What the wiki runs.
 * @param {string} theirsText The patched file.
 * @return {{ clean: boolean, text: string|null,
 *            conflicts: Array<{ baseStart: number, baseEnd: number }>,
 *            oursHunks: number, theirsHunks: number, reason: string|null }}
 *   Line numbers in conflicts are 1-based lines of the base.
 */
export function merge3( baseText, oursText, theirsText ) {
	const base = splitLines( baseText );
	const ours = splitLines( oursText );
	const theirs = splitLines( theirsText );

	const oursHunks = diffLines( base, ours );
	const theirsHunks = diffLines( base, theirs );
	if ( !oursHunks || !theirsHunks ) {
		return {
			clean: false, text: null, conflicts: [], oursHunks: 0, theirsHunks: 0,
			reason: 'The files are too different to merge.'
		};
	}

	// Put both sides' hunks in base order, then group the ones that touch.
	const tagged = [
		...oursHunks.map( ( h ) => ( { ...h, side: 'ours' } ) ),
		...theirsHunks.map( ( h ) => ( { ...h, side: 'theirs' } ) )
	].sort( ( x, y ) => x.aStart - y.aStart || x.aEnd - y.aEnd );

	const groups = [];
	for ( const h of tagged ) {
		const last = groups[ groups.length - 1 ];
		// Touching counts. Two insertions at one point, or an edit right
		// after another, are exactly where a silent merge goes wrong.
		if ( last && h.aStart <= last.end ) {
			last.hunks.push( h );
			last.end = Math.max( last.end, h.aEnd );
		} else {
			groups.push( { start: h.aStart, end: h.aEnd, hunks: [ h ] } );
		}
	}

	const out = [];
	const conflicts = [];
	let pos = 0;
	for ( const g of groups ) {
		out.push( ...base.slice( pos, g.start ) );
		const mine = g.hunks.filter( ( h ) => h.side === 'ours' );
		const yours = g.hunks.filter( ( h ) => h.side === 'theirs' );

		if ( !yours.length ) {
			out.push( ...applyHunks( base, ours, mine, g.start, g.end ) );
		} else if ( !mine.length ) {
			out.push( ...applyHunks( base, theirs, yours, g.start, g.end ) );
		} else {
			const a = applyHunks( base, ours, mine, g.start, g.end );
			const b = applyHunks( base, theirs, yours, g.start, g.end );
			if ( a.join( '\n' ) === b.join( '\n' ) ) {
				// Both sides made the same change, such as a backport of
				// this very patch. Take it once.
				out.push( ...a );
			} else {
				conflicts.push( { baseStart: g.start + 1, baseEnd: Math.max( g.end, g.start + 1 ) } );
				out.push( ...b );
			}
		}
		pos = g.end;
	}
	out.push( ...base.slice( pos ) );

	const clean = conflicts.length === 0;
	return {
		clean,
		text: clean ? out.join( '\n' ) : null,
		conflicts,
		oursHunks: oursHunks.length,
		theirsHunks: theirsHunks.length,
		reason: clean ? null :
			`${ conflicts.length } place(s) where the patch and the wiki both changed ` +
			'the same lines.'
	};
}

/**
 * Count what a whole-file replacement would do to the wiki's copy.
 *
 * @param {string} oursText What the wiki runs.
 * @param {string} baseText What the patch was written against.
 * @return {{ onlyOurs: number, onlyBase: number }|null} Lines the wiki has
 *   that the base lacks, and the other way round.
 */
export function driftBetween( oursText, baseText ) {
	const hunks = diffLines( splitLines( oursText ), splitLines( baseText ) );
	if ( !hunks ) {
		return null;
	}
	let onlyOurs = 0;
	let onlyBase = 0;
	for ( const h of hunks ) {
		onlyOurs += h.aEnd - h.aStart;
		onlyBase += h.bEnd - h.bStart;
	}
	return { onlyOurs, onlyBase };
}
