/**
 * "MAILFLOW" wordmark as pixel art: 5×7 cells per glyph, 1-cell strokes, notched corners,
 * 1¼-cell letter spacing.
 */
type Cell = [x: number, y: number, w: number, h: number];

const M: Cell[] = [[0, 0, 1, 7], [1, 1, 1, 1], [2, 2, 1, 2], [3, 1, 1, 1], [4, 0, 1, 7]];
const A: Cell[] = [[1, 0, 3, 1], [0, 1, 1, 6], [4, 1, 1, 6], [1, 3, 3, 1]];
const I: Cell[] = [[1, 0, 3, 1], [2, 1, 1, 5], [1, 6, 3, 1]];
const L: Cell[] = [[0, 0, 1, 7], [1, 6, 4, 1]];
const F: Cell[] = [[0, 0, 1, 7], [1, 0, 4, 1], [1, 3, 3, 1]];
const O: Cell[] = [[1, 0, 3, 1], [0, 1, 1, 5], [4, 1, 1, 5], [1, 6, 3, 1]];
const W: Cell[] = [[0, 0, 1, 6], [1, 6, 1, 1], [2, 3, 1, 3], [3, 6, 1, 1], [4, 0, 1, 6]];

const GLYPHS: Cell[][] = [M, A, I, L, F, L, O, W];
const GLYPH_W = 5;
const ROWS = 7;
const GAP = 1.25;
const WIDTH = GLYPHS.length * GLYPH_W + (GLYPHS.length - 1) * GAP;

export function Logo({ height = 20 }: { height?: number }) {
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${ROWS}`}
      height={height}
      width={(height / ROWS) * WIDTH}
      shapeRendering="crispEdges"
      role="img"
      aria-label="MailFlow"
      className="text-[#0a0a0a]"
    >
      {GLYPHS.map((cells, i) => (
        <g key={i} transform={`translate(${i * (GLYPH_W + GAP)} 0)`} fill="currentColor">
          {cells.map(([x, y, w, h], j) => <rect key={j} x={x} y={y} width={w} height={h} />)}
        </g>
      ))}
    </svg>
  );
}
