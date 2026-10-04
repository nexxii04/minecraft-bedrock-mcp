import type { BlockPosition, Rotation, Vec3 } from '../types.js';

/**
 * Bedrock angle conventions, matching the vanilla client:
 *
 * - `yaw` (degrees) is a clockwise rotation seen from above; `0` faces south
 *   (+Z), `90` faces west (-X), `-90`/`270` faces east (+X).
 * - `pitch` (degrees) is positive when looking **down**; `-90` is straight up.
 */

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtractVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Rounds a floating point position down to the block that contains it. */
export function toBlockPosition(position: Vec3): BlockPosition {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

/** Centre of a block, which is where a player has to stand to be "on" it. */
export function blockCenter(block: BlockPosition): Vec3 {
  return { x: block.x + 0.5, y: block.y, z: block.z + 0.5 };
}

export function blockKey(block: BlockPosition): string {
  return `${block.x},${block.y},${block.z}`;
}

export function parseBlockKey(key: string): BlockPosition | null {
  const parts = key.split(',');
  if (parts.length !== 3) return null;
  const [x, y, z] = parts.map((part) => Number(part));
  if (x === undefined || y === undefined || z === undefined) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/** Wraps an angle into `(-180, 180]`. */
export function normalizeAngle(degrees: number): number {
  let angle = degrees % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

/**
 * Rotation that makes the player look at `target` from `from`. Matches what the
 * vanilla client would send.
 */
export function rotationToLookAt(from: Vec3, target: Vec3): Rotation {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dz = target.z - from.z;
  const yaw = (-Math.atan2(dx, dz) * 180) / Math.PI;
  const horizontal = Math.hypot(dx, dz);
  const pitch = (-Math.atan2(dy, horizontal) * 180) / Math.PI;
  return {
    yaw: normalizeAngle(yaw),
    pitch: normalizeAngle(pitch),
    headYaw: normalizeAngle(yaw),
  };
}

/** Cardinal direction implied by a yaw value, handy for readable evidence logs. */
export function yawToCardinal(yaw: number): 'north' | 'south' | 'east' | 'west' {
  const normalized = normalizeAngle(yaw);
  if (normalized >= -45 && normalized < 45) return 'south';
  if (normalized >= 45 && normalized < 135) return 'west';
  if (normalized >= -135 && normalized < -45) return 'east';
  return 'north';
}

/** Face index used by `player_action`/item-use packets, derived from a look vector. */
export type BlockFace = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

/**
 * Bedrock numbers block faces 0..5 in the order below. Both `player_action` and
 * item-use transactions rely on it, so it lives here instead of in each builder.
 */
export const BLOCK_FACE_INDEX: Record<BlockFace, number> = {
  down: 0,
  up: 1,
  north: 2,
  south: 3,
  west: 4,
  east: 5,
};

export function faceIndex(face: BlockFace): number {
  return BLOCK_FACE_INDEX[face];
}

/** Block adjacent to `block` on the given face; where a placed block would land. */
export function offsetByFace(block: BlockPosition, face: BlockFace): BlockPosition {
  switch (face) {
    case 'down':
      return { x: block.x, y: block.y - 1, z: block.z };
    case 'up':
      return { x: block.x, y: block.y + 1, z: block.z };
    case 'north':
      return { x: block.x, y: block.y, z: block.z - 1 };
    case 'south':
      return { x: block.x, y: block.y, z: block.z + 1 };
    case 'west':
      return { x: block.x - 1, y: block.y, z: block.z };
    case 'east':
      return { x: block.x + 1, y: block.y, z: block.z };
  }
}

/**
 * Backwards from `offsetByFace`: given the clicked block and the block we want to
 * fill, which face of the clicked block to hit.
 */
export function faceTowards(block: BlockPosition, target: BlockPosition): BlockFace | null {
  const dx = target.x - block.x;
  const dy = target.y - block.y;
  const dz = target.z - block.z;
  if (dx === 0 && dy === 1 && dz === 0) return 'up';
  if (dx === 0 && dy === -1 && dz === 0) return 'down';
  if (dx === 0 && dy === 0 && dz === -1) return 'north';
  if (dx === 0 && dy === 0 && dz === 1) return 'south';
  if (dx === -1 && dy === 0 && dz === 0) return 'west';
  if (dx === 1 && dy === 0 && dz === 0) return 'east';
  return null;
}

/** Position relative to a block, expressed in the 0..1 space item-use packets want. */
export function clickPositionForFace(face: BlockFace): Vec3 {
  switch (face) {
    case 'down':
      return { x: 0.5, y: 0, z: 0.5 };
    case 'up':
      return { x: 0.5, y: 1, z: 0.5 };
    case 'north':
      return { x: 0.5, y: 0.5, z: 0 };
    case 'south':
      return { x: 0.5, y: 0.5, z: 1 };
    case 'west':
      return { x: 0, y: 0.5, z: 0.5 };
    case 'east':
      return { x: 1, y: 0.5, z: 0.5 };
  }
}

/** Nearest face of `block` to a viewer, used when the caller does not specify one. */
export function closestFace(block: BlockPosition, viewer: Vec3): BlockFace {
  const dx = viewer.x - (block.x + 0.5);
  const dy = viewer.y - (block.y + 0.5);
  const dz = viewer.z - (block.z + 0.5);
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const absZ = Math.abs(dz);
  if (absY >= absX && absY >= absZ) return dy > 0 ? 'up' : 'down';
  if (absX >= absZ) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

export function formatVec3(v: Vec3): string {
  return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
}

export function formatBlock(b: BlockPosition): string {
  return `${b.x}, ${b.y}, ${b.z}`;
}
