export const MAX_BLACK = 0.1;
export const GRAY_BAR_RANGE: readonly [number, number] = [0.45, 0.52];
export const SNAP = 0.05;
export const MIN_SEGMENT = 1.0;
export const STRAIGHT_ANGLE = 10;
export const MIN_SHAPE_LENGTH = 8.0;
export const MIN_TEXT_STROKES = 5;
export const TEXT_GAP = 4.0;

export const COLORS: Record<string, readonly [number, number, number]> = {
  straight: [0, 160, 0],
  L: [255, 0, 0],
  U: [0, 0, 255],
  Z: [255, 0, 255],
  closed: [0, 140, 255],
  other: [128, 0, 128],
};
