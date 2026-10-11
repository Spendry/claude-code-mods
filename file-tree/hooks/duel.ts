// Two stick figures that fence while Claude works and meditate while it waits, drawn as Raster
// cells: [codePoint, foreground, background] per cell. Pure: the module times it and blits it.
//
// The animation is a graph of clips. Each clip runs from one stance to another and ends on that
// stance's own frame, so any clip that starts there joins on without a jump. At each clip's end
// the player picks the next one at random from those leaving the stance it is in, preferring the
// mode it is asked for and taking a bridge clip (rise, bow and kneel, disengage) to get there.

export const DUEL_ROWS = 4
const SPRITE = 8
const DEFAULT = 0x01000000

const BODY = 0x5c5c5c
const BLADE_LEFT = 0x9a5a28
const BLADE_RIGHT = 0x3f6f8f
const SPARK = 0xb0903a
const AURA = 0x5a4a7a

/** One pose, facing right, 8 columns by 4 rows: body and blade as separate layers, spaces transparent. */
type Pose = { body: string[]; blade: string[] }

const POSES = {
  guard: {
    body: ['  o     ', ' /|-    ', '  |     ', ' / \\    '],
    blade: ['     ╱  ', '    ╱   ', '        ', '        '],
  },
  step: {
    body: ['  o     ', ' /|-    ', '  |     ', '  /|    '],
    blade: ['     ╱  ', '    ╱   ', '        ', '        '],
  },
  thrust: {
    body: ['  o     ', ' /|--   ', '  |     ', ' /  \\   '],
    blade: ['        ', '     ───', '        ', '        '],
  },
  parry: {
    body: ['  o     ', ' /|-    ', '  |     ', ' / \\    '],
    blade: ['    │   ', '    │   ', '        ', '        '],
  },
  high: {
    body: ['  o_    ', ' /|     ', '  |     ', ' / \\    '],
    blade: ['    ─── ', '        ', '        ', '        '],
  },
  low: {
    body: ['  o     ', ' /|     ', '  |\\    ', ' /  \\   '],
    blade: ['        ', '        ', '    ─── ', '        '],
  },
  recoil: {
    body: ['\\o      ', ' |\\     ', ' |      ', '/ >     '],
    blade: ['        ', '        ', '        ', '   ──   '],
  },
  bow: {
    body: ['        ', '  _o    ', '   |\\   ', '  / \\   '],
    blade: ['        ', '        ', '      │ ', '      │ '],
  },
  kneel: {
    body: ['        ', '  o     ', ' /|-    ', '  |_\\   '],
    blade: ['        ', '    │   ', '    │   ', '    ┴   '],
  },
  sit: {
    body: ['        ', '   o    ', '  /|\\   ', '  /_\\   '],
    blade: ['        ', '        ', '        ', '      ──'],
  },
  breathe: {
    body: ['        ', '  \\o/   ', '   |    ', '  /_\\   '],
    blade: ['        ', '        ', '        ', '      ──'],
  },
} satisfies Record<string, Pose>

type PoseName = keyof typeof POSES

/** gap: columns between the two 8-wide sprite boxes, negative where they overlap. */
export type Beat = {
  left: PoseName
  right: PoseName
  gap: number
  /** The blades meet: a spark where they touch. */
  clash?: boolean
  /** Dots above the seated heads. */
  aura?: 1 | 2
  /** How many ticks this beat holds; 1 when absent. */
  hold?: number
}

export type Stance = 'apart' | 'close' | 'seated'
export type Mode = 'fight' | 'calm'

/** The frame each stance rests on: every clip ending at a stance ends on exactly this beat. */
export const STANCE: Record<Stance, Beat> = {
  apart: { left: 'guard', right: 'guard', gap: -1 },
  close: { left: 'guard', right: 'guard', gap: -5 },
  seated: { left: 'sit', right: 'sit', gap: 1, hold: 2 },
}

export type Clip = {
  name: string
  from: Stance
  to: Stance
  /** fight and calm clips play in their mode; a bridge plays to reach the other mode's stances. */
  mode: Mode | 'bridge'
  /** For a bridge: the mode it leads toward. */
  toward?: Mode
  beats: Beat[]
}

const S = STANCE

export const CLIPS: Clip[] = [
  // Fighting, while Claude works.
  {
    name: 'approach',
    from: 'apart',
    to: 'close',
    mode: 'fight',
    beats: [
      { left: 'step', right: 'guard', gap: -2 },
      { left: 'guard', right: 'step', gap: -3 },
      { left: 'step', right: 'guard', gap: -4 },
      S.close,
    ],
  },
  {
    name: 'lunge',
    from: 'apart',
    to: 'close',
    mode: 'fight',
    beats: [
      { left: 'step', right: 'guard', gap: -2 },
      { left: 'step', right: 'parry', gap: -4 },
      { left: 'thrust', right: 'parry', gap: -5, clash: true },
      S.close,
    ],
  },
  {
    name: 'circle',
    from: 'apart',
    to: 'apart',
    mode: 'fight',
    beats: [
      { left: 'step', right: 'step', gap: -1 },
      { left: 'parry', right: 'guard', gap: -1 },
      { left: 'guard', right: 'parry', gap: -1 },
      S.apart,
    ],
  },
  {
    name: 'exchange',
    from: 'close',
    to: 'close',
    mode: 'fight',
    beats: [
      { left: 'thrust', right: 'parry', gap: -5, clash: true },
      { left: 'guard', right: 'guard', gap: -5 },
      { left: 'parry', right: 'thrust', gap: -5, clash: true },
      S.close,
    ],
  },
  {
    name: 'high-low',
    from: 'close',
    to: 'close',
    mode: 'fight',
    beats: [
      { left: 'high', right: 'high', gap: -5, clash: true },
      { left: 'low', right: 'low', gap: -5, clash: true },
      { left: 'high', right: 'parry', gap: -5 },
      S.close,
    ],
  },
  {
    name: 'feint',
    from: 'close',
    to: 'close',
    mode: 'fight',
    beats: [
      { left: 'step', right: 'guard', gap: -4 },
      { left: 'low', right: 'parry', gap: -5 },
      { left: 'thrust', right: 'parry', gap: -5, clash: true },
      S.close,
    ],
  },
  {
    name: 'left-wins',
    from: 'close',
    to: 'apart',
    mode: 'fight',
    beats: [
      { left: 'thrust', right: 'recoil', gap: -5 },
      { left: 'guard', right: 'recoil', gap: -4, hold: 2 },
      { left: 'guard', right: 'step', gap: -3 },
      { left: 'guard', right: 'guard', gap: -2 },
      S.apart,
    ],
  },
  {
    name: 'right-wins',
    from: 'close',
    to: 'apart',
    mode: 'fight',
    beats: [
      { left: 'recoil', right: 'thrust', gap: -5 },
      { left: 'recoil', right: 'guard', gap: -4, hold: 2 },
      { left: 'step', right: 'guard', gap: -3 },
      { left: 'guard', right: 'guard', gap: -2 },
      S.apart,
    ],
  },

  // Meditating, while Claude waits.
  {
    name: 'breathe',
    from: 'seated',
    to: 'seated',
    mode: 'calm',
    beats: [
      { left: 'sit', right: 'sit', gap: 1, hold: 3 },
      { left: 'breathe', right: 'breathe', gap: 1, hold: 4 },
      S.seated,
    ],
  },
  {
    name: 'aura',
    from: 'seated',
    to: 'seated',
    mode: 'calm',
    beats: [
      { left: 'sit', right: 'sit', gap: 1, aura: 1, hold: 3 },
      { left: 'sit', right: 'sit', gap: 1, aura: 2, hold: 3 },
      { left: 'sit', right: 'sit', gap: 1, aura: 1, hold: 3 },
      S.seated,
    ],
  },
  {
    name: 'stillness',
    from: 'seated',
    to: 'seated',
    mode: 'calm',
    beats: [{ left: 'sit', right: 'sit', gap: 1, hold: 6 }, S.seated],
  },

  // Bridges between the two.
  {
    name: 'disengage',
    from: 'close',
    to: 'apart',
    mode: 'bridge',
    toward: 'calm',
    beats: [
      { left: 'parry', right: 'parry', gap: -4 },
      { left: 'step', right: 'step', gap: -3 },
      { left: 'guard', right: 'guard', gap: -2 },
      S.apart,
    ],
  },
  {
    name: 'bow-and-kneel',
    from: 'apart',
    to: 'seated',
    mode: 'bridge',
    toward: 'calm',
    beats: [
      { left: 'bow', right: 'bow', gap: 0, hold: 2 },
      { left: 'kneel', right: 'kneel', gap: 1, hold: 2 },
      S.seated,
    ],
  },
  {
    name: 'rise',
    from: 'seated',
    to: 'apart',
    mode: 'bridge',
    toward: 'fight',
    beats: [
      { left: 'kneel', right: 'kneel', gap: 1, hold: 2 },
      { left: 'bow', right: 'bow', gap: 0, hold: 2 },
      S.apart,
    ],
  },
]

export type Player = { stance: Stance; clip: Clip | undefined; index: number; held: number; beat: Beat }

/** A player resting seated, as a session starts before Claude has worked. */
export function createPlayer(): Player {
  return { stance: 'seated', clip: undefined, index: 0, held: 0, beat: STANCE.seated }
}

/** The next clip from where the player stands: one of the wanted mode, else a bridge toward it. */
export function nextClip(stance: Stance, want: Mode, random: () => number = Math.random): Clip {
  const leaving = CLIPS.filter(clip => clip.from === stance)
  const own = leaving.filter(clip => clip.mode === want)
  const bridge = leaving.filter(clip => clip.mode === 'bridge' && clip.toward === want)
  const pool = own.length > 0 ? own : bridge.length > 0 ? bridge : leaving
  return pool[Math.floor(random() * pool.length) % pool.length]
}

/** Advances one tick and returns the beat to draw. Clips always finish; the mode only steers the next pick. */
export function advance(player: Player, want: Mode, random: () => number = Math.random): Beat {
  if (player.held + 1 < (player.beat.hold ?? 1)) {
    player.held++
    return player.beat
  }
  player.held = 0
  if (player.clip === undefined || player.index >= player.clip.beats.length) {
    player.clip = nextClip(player.stance, want, random)
    player.index = 0
  }
  player.beat = player.clip.beats[player.index++]
  if (player.index >= player.clip.beats.length) player.stance = player.clip.to
  return player.beat
}

const SWAP: Record<string, string> = { '/': '\\', '\\': '/', '╱': '╲', '╲': '╱', '<': '>', '>': '<', '(': ')', ')': '(' }

function mirror(rows: string[]): string[] {
  return rows.map(row => [...row].reverse().map(ch => SWAP[ch] ?? ch).join(''))
}

/** '#0f0f0f' to 0x0f0f0f; anything else is the terminal's own background. */
export function parseColor(hex: string | undefined): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '')
  return m ? parseInt(m[1], 16) : DEFAULT
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

/** The cells of one beat on a strip `columns` wide, packed for a Raster; blank when too narrow. */
export function beatCells(beat: Beat, columns: number, background = DEFAULT): string {
  const width = Math.max(1, columns)
  const glyph = new Array<number>(width * DUEL_ROWS).fill(32)
  const color = new Array<number>(width * DUEL_ROWS).fill(DEFAULT)
  const at = (row: number, col: number) => row * width + col
  const inside = (row: number, col: number) => col >= 0 && col < width && row >= 0 && row < DUEL_ROWS
  const put = (row: number, col: number, ch: string, fg: number) => {
    if (ch === ' ' || !inside(row, col)) return
    glyph[at(row, col)] = ch.codePointAt(0) ?? 32
    color[at(row, col)] = fg
  }
  /** Draws a layer and returns the cells it covered, for finding where blades meet. */
  const draw = (rows: string[], x: number, fg: number) => {
    const covered: [number, number][] = []
    rows.forEach((line, row) =>
      [...line].forEach((ch, i) => {
        if (ch === ' ') return
        put(row, x + i, ch, fg)
        covered.push([row, x + i])
      }),
    )
    return covered
  }

  if (width >= SPRITE * 2 + 2) {
    const total = SPRITE * 2 + beat.gap
    const leftX = Math.floor((width - total) / 2)
    const rightX = leftX + SPRITE + beat.gap
    const left = POSES[beat.left]
    const right = POSES[beat.right]

    draw(left.body, leftX, BODY)
    draw(mirror(right.body), rightX, BODY)
    const leftBlade = draw(left.blade, leftX, BLADE_LEFT)
    const leftGlyphs = new Map(leftBlade.map(([r, c]) => [at(r, c), glyph[at(r, c)]]))
    const rightBlade = draw(mirror(right.blade), rightX, BLADE_RIGHT)
    // Two diagonals in one cell are crossed blades.
    const diagonals = new Set(['╱', '╲'].map(ch => ch.codePointAt(0)))
    for (const [r, c] of rightBlade) {
      const under = leftGlyphs.get(at(r, c))
      if (under !== undefined && under !== glyph[at(r, c)] && diagonals.has(under) && diagonals.has(glyph[at(r, c)]))
        put(r, c, '╳', BODY)
    }

    if (beat.clash) {
      // The first cell where the blades touch: shared, or side by side on one row.
      const near = leftBlade.find(([r, c]) => rightBlade.some(([r2, c2]) => r2 === r && Math.abs(c2 - c) <= 1))
      if (near) put(near[0], near[1], '*', SPARK)
    }
    if (beat.aura) {
      const heads = [leftX + 3, rightX + SPRITE - 1 - 3]
      for (const head of heads) {
        put(0, head, '·', AURA)
        if (beat.aura === 2) {
          put(0, head - 1, '·', AURA)
          put(0, head + 1, '·', AURA)
        }
      }
    }
  }

  const words = new Uint32Array(width * DUEL_ROWS * 3)
  for (let i = 0; i < width * DUEL_ROWS; i++) {
    words[i * 3] = glyph[i]
    words[i * 3 + 1] = color[i]
    words[i * 3 + 2] = background
  }
  return base64(new Uint8Array(words.buffer))
}
