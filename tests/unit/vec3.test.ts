import { describe, expect, it } from 'vitest';

import {
  blockCenter,
  blockKey,
  closestFace,
  distance,
  faceIndex,
  faceTowards,
  offsetByFace,
  parseBlockKey,
  rotationToLookAt,
  toBlockPosition,
  yawToCardinal,
} from '../../src/bedrock/vec3.js';

/**
 * These helpers encode Bedrock's coordinate conventions, which are the easiest
 * thing in the whole project to get subtly backwards. Yaw 0 faces +Z, `pitch` is
 * positive when looking down, and block faces are numbered 0..5 in a fixed order.
 */

describe('rotationToLookAt', () => {
  const origin = { x: 0, y: 64, z: 0 };

  it('faces south (+Z) at yaw 0', () => {
    const rotation = rotationToLookAt(origin, { x: 0, y: 64, z: 10 });
    expect(rotation.yaw).toBeCloseTo(0, 5);
    expect(rotation.pitch).toBeCloseTo(0, 5);
    expect(yawToCardinal(rotation.yaw)).toBe('south');
  });

  it('faces west (-X) at yaw 90', () => {
    const rotation = rotationToLookAt(origin, { x: -10, y: 64, z: 0 });
    expect(rotation.yaw).toBeCloseTo(90, 5);
    expect(yawToCardinal(rotation.yaw)).toBe('west');
  });

  it('faces east (+X) at yaw -90', () => {
    const rotation = rotationToLookAt(origin, { x: 10, y: 64, z: 0 });
    expect(rotation.yaw).toBeCloseTo(-90, 5);
    expect(yawToCardinal(rotation.yaw)).toBe('east');
  });

  it('faces north (-Z) at yaw 180', () => {
    const rotation = rotationToLookAt(origin, { x: 0, y: 64, z: -10 });
    expect(Math.abs(rotation.yaw)).toBeCloseTo(180, 5);
    expect(yawToCardinal(rotation.yaw)).toBe('north');
  });

  it('looks up with a negative pitch and down with a positive one', () => {
    expect(rotationToLookAt(origin, { x: 0, y: 74, z: 10 }).pitch).toBeLessThan(0);
    expect(rotationToLookAt(origin, { x: 0, y: 54, z: 10 }).pitch).toBeGreaterThan(0);
    // Straight up and straight down sit at ±90 (the magnitude, at least).
    expect(Math.abs(rotationToLookAt(origin, { x: 0, y: 74, z: 0 }).pitch)).toBeCloseTo(90, 5);
    expect(Math.abs(rotationToLookAt(origin, { x: 0, y: 54, z: 0 }).pitch)).toBeCloseTo(90, 5);
  });

  it('mirrors yaw into head yaw', () => {
    const rotation = rotationToLookAt(origin, { x: 5, y: 64, z: 5 });
    expect(rotation.headYaw).toBe(rotation.yaw);
  });
});

describe('block geometry', () => {
  it('floors positions onto the containing block', () => {
    expect(toBlockPosition({ x: 1.9, y: 64.0, z: -0.1 })).toEqual({ x: 1, y: 64, z: -1 });
  });

  it('centres blocks on their x/z midpoints, keeping y at the base', () => {
    expect(blockCenter({ x: 3, y: 64, z: -2 })).toEqual({ x: 3.5, y: 64, z: -1.5 });
  });

  it('round-trips block keys', () => {
    const key = blockKey({ x: -12, y: 5, z: 300 });
    expect(key).toBe('-12,5,300');
    expect(parseBlockKey(key)).toEqual({ x: -12, y: 5, z: 300 });
  });

  it('rejects malformed block keys instead of returning NaN coordinates', () => {
    expect(parseBlockKey('1,2')).toBeNull();
    expect(parseBlockKey('a,b,c')).toBeNull();
    expect(parseBlockKey('1,2,3,4')).toBeNull();
    expect(parseBlockKey('')).toBeNull();
  });

  it('numbers faces in the order Bedrock expects', () => {
    expect(faceIndex('down')).toBe(0);
    expect(faceIndex('up')).toBe(1);
    expect(faceIndex('north')).toBe(2);
    expect(faceIndex('south')).toBe(3);
    expect(faceIndex('west')).toBe(4);
    expect(faceIndex('east')).toBe(5);
  });

  it('offsets by face in the right direction', () => {
    const block = { x: 0, y: 0, z: 0 };
    expect(offsetByFace(block, 'up')).toEqual({ x: 0, y: 1, z: 0 });
    expect(offsetByFace(block, 'down')).toEqual({ x: 0, y: -1, z: 0 });
    expect(offsetByFace(block, 'north')).toEqual({ x: 0, y: 0, z: -1 });
    expect(offsetByFace(block, 'south')).toEqual({ x: 0, y: 0, z: 1 });
    expect(offsetByFace(block, 'west')).toEqual({ x: -1, y: 0, z: 0 });
    expect(offsetByFace(block, 'east')).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('recovers the clicked face from a target block', () => {
    const block = { x: 5, y: 64, z: 5 };
    for (const face of ['down', 'up', 'north', 'south', 'west', 'east'] as const) {
      expect(faceTowards(block, offsetByFace(block, face))).toBe(face);
    }
    // A diagonal neighbour has no single face.
    expect(faceTowards(block, { x: 6, y: 65, z: 6 })).toBeNull();
  });

  it('picks the face closest to the viewer', () => {
    const block = { x: 0, y: 64, z: 0 };
    expect(closestFace(block, { x: 0.5, y: 70, z: 0.5 })).toBe('up');
    expect(closestFace(block, { x: 0.5, y: 60, z: 0.5 })).toBe('down');
    expect(closestFace(block, { x: 10, y: 64.5, z: 0.5 })).toBe('east');
    expect(closestFace(block, { x: -10, y: 64.5, z: 0.5 })).toBe('west');
    expect(closestFace(block, { x: 0.5, y: 64.5, z: 10 })).toBe('south');
    expect(closestFace(block, { x: 0.5, y: 64.5, z: -10 })).toBe('north');
  });
});

describe('distance', () => {
  it('measures straight-line distance in three dimensions', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(distance({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })).toBe(0);
  });
});
