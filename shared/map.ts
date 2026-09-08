import type { Vec3 } from './protocol.js';
export const ARENA_HALF = 32;
export interface MapObstacle {
  id: string; x: number; y: number; z: number; w: number; h: number; d: number;
  color: string; kind: 'wall' | 'cover' | 'platform' | 'step';
}
/** Box centers; feet live on y=0. Geometry is shared by visual and hit/collision code. */
export const OBSTACLES: MapObstacle[] = [
  { id: 'north-arch-left', x: -8, y: 2.5, z: -17, w: 5, h: 5, d: 5, color: '#edd9b6', kind: 'wall' },
  { id: 'north-arch-right', x: 8, y: 2.5, z: -17, w: 5, h: 5, d: 5, color: '#edd9b6', kind: 'wall' },
  { id: 'north-arch-top', x: 0, y: 5.4, z: -17, w: 21, h: 1.2, d: 5, color: '#eec798', kind: 'wall' },
  { id: 'south-platform', x: 0, y: 1, z: 17, w: 14, h: 2, d: 8, color: '#eacaa1', kind: 'platform' },
  { id: 'south-step-1', x: 0, y: 0.2, z: 9.5, w: 7, h: 0.4, d: 1.4, color: '#f0d9b4', kind: 'step' },
  { id: 'south-step-2', x: 0, y: 0.4, z: 10.7, w: 7, h: 0.8, d: 1.2, color: '#f0d9b4', kind: 'step' },
  { id: 'south-step-3', x: 0, y: 0.6, z: 11.8, w: 7, h: 1.2, d: 1.2, color: '#f0d9b4', kind: 'step' },
  { id: 'south-step-4', x: 0, y: 0.8, z: 12.8, w: 7, h: 1.6, d: 1, color: '#f0d9b4', kind: 'step' },
  { id: 'west-block', x: -19, y: 1.75, z: -1, w: 8, h: 3.5, d: 13, color: '#efa480', kind: 'wall' },
  { id: 'east-block', x: 19, y: 1.75, z: 1, w: 8, h: 3.5, d: 13, color: '#debb91', kind: 'wall' },
  { id: 'center-cover-west', x: -5, y: 0.8, z: 0, w: 3.5, h: 1.6, d: 6, color: '#e5b693', kind: 'cover' },
  { id: 'center-cover-east', x: 5, y: 0.8, z: 0, w: 3.5, h: 1.6, d: 6, color: '#e5b693', kind: 'cover' },
  { id: 'north-cover', x: 0, y: 0.65, z: -8, w: 5, h: 1.3, d: 2, color: '#cdd8b4', kind: 'cover' },
  { id: 'sw-cover', x: -17, y: 0.9, z: 19, w: 4, h: 1.8, d: 3, color: '#c8d3af', kind: 'cover' },
  { id: 'ne-cover', x: 19, y: 0.9, z: -21, w: 4, h: 1.8, d: 3, color: '#c8d3af', kind: 'cover' },
  { id: 'nw-cover', x: -22, y: 0.9, z: -19, w: 3, h: 1.8, d: 4, color: '#c8d3af', kind: 'cover' },
  { id: 'se-cover', x: 22, y: 0.9, z: 19, w: 3, h: 1.8, d: 4, color: '#c8d3af', kind: 'cover' },
];
export const SPAWNS: Array<Vec3 & { yaw: number }> = [
  { x: -26, y: 0, z: 26, yaw: Math.PI / 4 }, { x: 26, y: 0, z: -26, yaw: -3 * Math.PI / 4 },
  { x: 26, y: 0, z: 26, yaw: -Math.PI / 4 }, { x: -26, y: 0, z: -26, yaw: 3 * Math.PI / 4 },
  { x: 0, y: 0, z: 28, yaw: 0 }, { x: 0, y: 0, z: -28, yaw: Math.PI },
  { x: -28, y: 0, z: 0, yaw: Math.PI / 2 }, { x: 28, y: 0, z: 0, yaw: -Math.PI / 2 },
];
export const MAP_NAME = 'Sunbreak Courtyard';
