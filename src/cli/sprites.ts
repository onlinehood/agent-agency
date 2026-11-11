/**
 * Agent avatars: small, friendly blob characters built from parts — a body shape, a colour and an
 * accessory — with a face that shows what the agent is doing (resting, working, waiting for an
 * approval, stuck, done). Original designs; expression only, never used for roles, permissions or
 * assignment. Rendered with half blocks, about 14×12 px = 6 terminal lines.
 */

export const SHAPES = {
  // '#' body. Eyes sit on row `eyes`; `cx` is the face centre column.
  blob: { labelKo: "동글", eyes: 4, cx: 6, rows: ["...######...", ".##########.", "############", "############", "############", "############", "############", ".##########.", "...######..."] },
  pebble: { labelKo: "몽돌", eyes: 4, cx: 6, rows: [".##########.", "############", "############", "############", "############", "############", "############", "############", ".##########."] },
  drop: { labelKo: "물방울", eyes: 5, cx: 6, rows: [".....##.....", "....####....", "...######...", "..########..", ".##########.", "############", "############", "############", ".##########.", "...######..."] },
  cloud: { labelKo: "구름", eyes: 4, cx: 7, rows: ["...###..###....", "..#####.#####..", ".#############.", "###############", "###############", "###############", "###############", ".#############.", "..####...####.."] },
  ghost: { labelKo: "유령", eyes: 3, cx: 6, rows: ["...######...", ".##########.", "############", "############", "############", "############", "############", "############", "##.##..##.##"] },
  mochi: { labelKo: "찹쌀떡", eyes: 3, cx: 7, rows: ["....######....", "..##########..", ".############.", "##############", "##############", "##############", ".############."] },
} as const;

/** [base, light, dark] as truecolor hex + hand-picked xterm-256 codes (SSH rarely sends COLORTERM). */
export const COLORS = {
  orange: { labelKo: "주황", px: [["#f39a5f", 209], ["#ffc8a0", 223], ["#c96a3a", 173]] },
  blue: { labelKo: "하늘", px: [["#6eaaf2", 75], ["#b0d4ff", 153], ["#3f77c2", 68]] },
  mint: { labelKo: "민트", px: [["#6fd3a8", 79], ["#b6f2d6", 158], ["#3c9c76", 36]] },
  lavender: { labelKo: "보라", px: [["#a990f2", 141], ["#d6c8ff", 189], ["#765ac6", 98]] },
  yellow: { labelKo: "노랑", px: [["#f6cf5c", 221], ["#ffeaa6", 229], ["#c79c2c", 178]] },
  pink: { labelKo: "분홍", px: [["#f39dba", 211], ["#ffd2e2", 225], ["#c86b8d", 168]] },
  gray: { labelKo: "회색", px: [["#b9c0cb", 250], ["#e4e8ef", 254], ["#858d9a", 245]] },
} as const;

type Px = readonly [string, number];
const INK: Px = ["#1e1a2b", 234]; // eyes
const BLUSH: Px = ["#ff8fa8", 211];
const WHITE: Px = ["#ffffff", 231];
const LEAF: Px = ["#6cc35a", 71];
const LEAF_DARK: Px = ["#3d8a3a", 28];
const GOLD: Px = ["#f6c34a", 221];
const GOLD_DARK: Px = ["#b8862a", 136];
const STEM: Px = ["#8a93a3", 246];
const RED: Px = ["#ef5b5b", 203];
const NAVY: Px = ["#3b4a7a", 60];
const SWEAT: Px = ["#9fd8ff", 153];
const RED_DARK: Px = ["#b83c3c", 131];

/** Accessories: drawn on a 3-row band above the body (rows may overlap the head). */
export const ACCESSORIES = {
  none: { labelKo: "없음" },
  sprout: { labelKo: "새싹" },
  antenna: { labelKo: "안테나" },
  scarf: { labelKo: "목도리" },
  ribbon: { labelKo: "리본" },
  crown: { labelKo: "왕관" },
  beanie: { labelKo: "비니" },
} as const;

export type Shape = keyof typeof SHAPES;
export type ColorName = keyof typeof COLORS;
export type Accessory = keyof typeof ACCESSORIES;
export type Mood = "idle" | "happy" | "working" | "waiting" | "worried" | "sleepy";

export interface Look {
  shape: Shape;
  color: ColorName;
  accessory: Accessory;
}

export const MOOD_KO: Record<Mood, string> = { idle: "쉬는 중", happy: "기분 좋음", working: "일하는 중", waiting: "승인 기다림", worried: "막힘", sleepy: "멈춤" };

/** The brand mascot shown when there is no team yet. */
export const MASCOT: Look = { shape: "mochi", color: "orange", accessory: "antenna" };

const DEFAULT_BY_ADAPTER: Record<string, Look> = {
  "claude-cli": { shape: "pebble", color: "orange", accessory: "sprout" },
  "claude-cloud": { shape: "pebble", color: "orange", accessory: "sprout" },
  "codex-cli": { shape: "blob", color: "blue", accessory: "scarf" },
  "codex-cloud": { shape: "blob", color: "blue", accessory: "scarf" },
  "gemini-cli": { shape: "drop", color: "lavender", accessory: "ribbon" },
  "cursor-cli": { shape: "ghost", color: "gray", accessory: "beanie" },
};
const EXTRA: Look[] = [
  { shape: "cloud", color: "mint", accessory: "crown" },
  { shape: "mochi", color: "yellow", accessory: "antenna" },
  { shape: "blob", color: "pink", accessory: "ribbon" },
];

export function defaultLook(adapterId: string, index = 0): Look {
  return DEFAULT_BY_ADAPTER[adapterId] ?? EXTRA[index % EXTRA.length]!;
}

export function isLook(v: unknown): v is Look {
  const l = v as Look | null;
  return !!l && typeof l === "object" && l.shape in SHAPES && l.color in COLORS && l.accessory in ACCESSORIES;
}

export const describeLook = (l: Look) => `${COLORS[l.color].labelKo} ${SHAPES[l.shape].labelKo}${l.accessory === "none" ? "" : ` · ${ACCESSORIES[l.accessory].labelKo}`}`;

/* ------------------------------------------------ composition */

type Grid = (Px | null)[][];
const TOP = 3; // accessory band

/** Build the pixel grid for a look and mood. */
export function composeAvatar(look: Look, mood: Mood = "idle"): Grid {
  const shape = SHAPES[look.shape];
  const [base, light, dark] = COLORS[look.color].px as readonly Px[];
  const w = Math.max(...shape.rows.map((r) => r.length)) + 2; // room for a sweat drop / sparkle
  const h = shape.rows.length + TOP;
  const g: Grid = Array.from({ length: h }, () => Array<Px | null>(w).fill(null));
  const body = (x: number, y: number) => shape.rows[y]?.[x] === "#";
  const set = (x: number, y: number, p: Px) => {
    if (y >= 0 && y < h && x >= 0 && x < w) g[y]![x] = p;
  };
  // body with soft shading: dark along the bottom/right edge, a light spot top-left
  shape.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!body(x, y)) continue;
      const edgeBottom = !body(x, y + 1);
      const edgeRight = !body(x + 1, y) && y > shape.rows.length / 2;
      set(x, y + TOP, edgeBottom || edgeRight ? dark! : base!);
    }
  });
  const firstX = (y: number) => shape.rows[y]!.indexOf("#");
  set(firstX(1) + 1, TOP + 1, light!);
  set(firstX(1) + 2, TOP + 1, light!);
  set(firstX(2) + 1, TOP + 2, light!);

  // face
  const ey = TOP + shape.eyes;
  const lx = shape.cx - 3;
  const rx = shape.cx + 2;
  const eye = (x: number) => {
    switch (mood) {
      case "happy": // ^ ^
        set(x, ey, INK);
        set(x - 1, ey + 1, INK);
        set(x + 1, ey + 1, INK);
        break;
      case "working": // focused, looking right
        set(x + 1, ey, INK);
        set(x + 1, ey + 1, INK);
        break;
      case "waiting": // wide eyes with a shine
        set(x, ey, WHITE);
        set(x, ey + 1, INK);
        set(x + 1, ey, INK);
        set(x + 1, ey + 1, INK);
        break;
      case "sleepy": // closed
        set(x - 1, ey + 1, INK);
        set(x, ey + 1, INK);
        set(x + 1, ey + 1, INK);
        break;
      default: // idle / worried: dots
        set(x, ey, INK);
        set(x, ey + 1, INK);
    }
  };
  eye(lx);
  eye(rx);
  if (mood === "idle" || mood === "happy" || mood === "waiting") {
    set(lx - 1, ey + 2, BLUSH);
    set(rx + 1, ey + 2, BLUSH);
  }
  if (mood === "happy") {
    set(shape.cx - 1, ey + 2, dark!);
    set(shape.cx, ey + 2, dark!);
  }
  if (mood === "worried") {
    set(shape.cx - 1, ey + 3, dark!);
    set(shape.cx, ey + 2, dark!);
    const sx = Math.max(...shape.rows.map((r) => r.lastIndexOf("#"))) + 1;
    set(sx, TOP + 1, SWEAT);
    set(sx, TOP + 2, SWEAT);
  }
  if (mood === "working") {
    // a little spark beside the body: busy
    const sx = Math.max(...shape.rows.map((r) => r.lastIndexOf("#"))) + 1;
    set(sx, TOP + 1, GOLD);
    set(sx + 1, TOP, GOLD);
    set(sx, TOP + 3, GOLD);
  }

  // accessory
  const top = shape.rows.findIndex((r) => r.includes("#"));
  const topRow = shape.rows[top]!;
  const mid = Math.round((topRow.indexOf("#") + topRow.lastIndexOf("#")) / 2);
  switch (look.accessory) {
    case "sprout":
      set(mid, TOP - 1, LEAF_DARK);
      set(mid - 1, TOP - 2, LEAF);
      set(mid - 2, TOP - 2, LEAF);
      set(mid + 1, TOP - 2, LEAF);
      set(mid + 1, TOP - 3, LEAF);
      set(mid + 2, TOP - 3, LEAF);
      break;
    case "antenna":
      set(mid, TOP - 1, STEM);
      set(mid, TOP - 2, STEM);
      set(mid, TOP - 3, RED);
      set(mid + 1, TOP - 3, RED);
      break;
    case "crown":
      for (let x = mid - 3; x <= mid + 3; x++) set(x, TOP - 1, GOLD_DARK);
      for (const x of [mid - 3, mid, mid + 3]) set(x, TOP - 2, GOLD);
      set(mid - 1, TOP - 2, GOLD);
      set(mid + 1, TOP - 2, GOLD);
      set(mid, TOP - 3, RED);
      break;
    case "ribbon": {
      const x0 = topRow.lastIndexOf("#") - 1;
      for (const [dx, dy] of [[-1, -1], [-1, 0], [0, 0], [1, 0], [1, -1], [2, -1], [-2, -1], [0, -1]] as const) set(x0 + dx, TOP + top + dy - 1, dx === 0 ? RED : BLUSH);
      break;
    }
    case "beanie": {
      const r0 = shape.rows[top]!;
      for (let x = r0.indexOf("#") - 1; x <= r0.lastIndexOf("#") + 1; x++) set(x, TOP + top, NAVY);
      const r1 = shape.rows[top + 1] ?? r0;
      for (let x = r1.indexOf("#"); x <= r1.lastIndexOf("#"); x++) if ((x + top) % 2 === 0) set(x, TOP + top + 1, NAVY);
      for (let x = mid - 3; x <= mid + 3; x++) set(x, TOP - 1, NAVY);
      set(mid, TOP - 2, WHITE);
      set(mid + 1, TOP - 2, WHITE);
      break;
    }
    case "scarf": {
      // a scarf around the lower body with a tail hanging on the right
      const y = Math.min(shape.rows.length - 1, Math.max(shape.eyes + 3, shape.rows.length - 2));
      const row = shape.rows[y]!;
      for (let x = row.indexOf("#"); x <= row.lastIndexOf("#"); x++) set(x, TOP + y, x % 3 === 0 ? RED_DARK : RED);
      const tx = row.lastIndexOf("#") - 2;
      set(tx, TOP + y + 1, RED);
      set(tx, TOP + y + 2, RED_DARK);
      break;
    }
  }

  // trim empty rows/columns
  while (g.length && g[0]!.every((p) => !p)) g.shift();
  while (g.length && g[g.length - 1]!.every((p) => !p)) g.pop();
  let left = 0;
  while (left < w && g.every((r) => !r[left])) left++;
  let right = w - 1;
  while (right > left && g.every((r) => !r[right])) right--;
  return g.map((r) => r.slice(left, right + 1));
}

/* ------------------------------------------------ terminal rendering */

export type ColorMode = "truecolor" | "256" | "none";

export function colorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR || env.TERM === "dumb") return "none";
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");

function sgr(mode: ColorMode, fg: Px | null, bg: Px | null): string {
  if (mode === "none") return "";
  const part = (c: Px, base: number) => (mode === "truecolor" ? `${base};2;${rgb(c[0])}` : `${base};5;${c[1]}`);
  return `\x1b[${[fg ? part(fg, 38) : "", bg ? part(bg, 48) : ""].filter(Boolean).join(";")}m`;
}

/**
 * Half-block rendering: each text cell holds two pixels (top = foreground "▀", bottom =
 * background), so every pixel keeps its own colour.
 */
export function renderGrid(g: Grid, mode: ColorMode = colorMode()): string[] {
  const w = Math.max(0, ...g.map((r) => r.length));
  const out: string[] = [];
  for (let y = 0; y < g.length; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const t = g[y]?.[x] ?? null;
      const b = g[y + 1]?.[x] ?? null;
      if (!t && !b) line += " ";
      else if (mode === "none") line += t && b ? "█" : t ? "▀" : "▄";
      else if (!b) line += `${sgr(mode, t, null)}▀\x1b[0m`;
      else if (!t) line += `${sgr(mode, b, null)}▄\x1b[0m`;
      else if (t[0] === b[0]) line += `${sgr(mode, t, null)}█\x1b[0m`;
      else line += `${sgr(mode, t, b)}▀\x1b[0m`;
    }
    out.push(line);
  }
  return out;
}

export const avatar = (look: Look, mood: Mood = "idle", mode?: ColorMode) => renderGrid(composeAvatar(look, mood), mode);
