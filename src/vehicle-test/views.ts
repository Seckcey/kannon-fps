/** Fixed views for the local graphics review (vehicle-test.html and graphics-test.html). `player`
 *  is where the review character stands, and where the first-person camera sits in player views;
 *  views with a `camera` look from there at `target` instead. Every player position stands clear
 *  of the collision map (tests/assets/review-views.test.ts), so a capture never starts inside
 *  cover and Walk around never starts stuck. */
export type Vec = [number, number, number];
/** `showPlayer` keeps the review character visible in a fixed-camera view (it is hidden there
 *  otherwise), so its real-time shadow can be judged against the bake. */
export interface ReviewView { label: string; player: Vec; yaw: number; pitch: number; camera?: Vec; target?: Vec; showPlayer?: boolean }

// Behind the west-lane sandbags (the v3 cover box at -7, -13 sits where v2's player stood),
// looking over them at the bus.
const BUS_PLAYER: Vec = [-7.75, 0, -14.4];

export const VEHICLE_VIEWS: Record<string, ReviewView> = {
  'bus-close': { label: 'Bus · close detail', player: BUS_PLAYER, yaw: 2.65, pitch: -.04, camera: [-8.2, 3.1, -14.3], target: [-2.4, 1.5, -6.2] },
  'bus-gameplay': { label: 'Bus · player view', player: BUS_PLAYER, yaw: 2.65, pitch: -.025 },
  'bus-detail': { label: 'Bus · wheel and panel detail', player: BUS_PLAYER, yaw: 2.65, pitch: -.025, camera: [-6.1, 1.8, -10.6], target: [-3.0, 1.25, -8.0] },
  'south-close': { label: 'South car · close detail', player: [-7, 0, 20.7], yaw: .6, pitch: -.04, camera: [-7.5, 2.3, 19.3], target: [-3.9, .95, 16.2] },
  'south-gameplay': { label: 'South car · player view', player: [-7, 0, 20.7], yaw: .6, pitch: -.06 },
  'south-detail': { label: 'South car · wheel and panel detail', player: [-7, 0, 20.7], yaw: .6, pitch: -.06, camera: [-5.7, 1.25, 18.7], target: [-4.7, .68, 16.65] },
  'north-close': { label: 'North car · close detail', player: [0, 0, -12.5], yaw: .686, pitch: -.04, camera: [.2, 2.3, -14.2], target: [4, .95, -17.4] },
  'north-gameplay': { label: 'North car · player view', player: [0, 0, -12.5], yaw: .686, pitch: -.06 },
};

export const TOWN_VIEWS: Record<string, ReviewView> = {
  'street': { label: 'Main street · architecture', player: [0, 0, 17], yaw: 0, pitch: -.04, camera: [3.5, 3.8, 19.5], target: [-6, 2.2, -3] },
  'teal-front': { label: 'Teal house · siding and windows', player: [-5, 0, -9], yaw: -1, pitch: 0, camera: [-3.5, 3, -11.5], target: [-11, 3.3, -.5] },
  'yellow-front': { label: 'Yellow house · facade and garage', player: [4.8, 0, 16], yaw: 2, pitch: 0, camera: [4.2, 3.4, 18.8], target: [12, 3, 3.5] },
  'roof-detail': { label: 'Roof · ridge and gutter detail', player: BUS_PLAYER, yaw: 0, pitch: 0, camera: [-9, 7.6, -13.7], target: [-16, 6.8, -3.5] },
  'teal-room': { label: 'Teal house · ground floor', player: [-13, 0, 0], yaw: 0, pitch: 0, camera: [-10.7, 1.75, 4.8], target: [-16.4, 1.2, -3.1] },
  'yellow-upstairs': { label: 'Yellow house · upstairs', player: [13, 3.2, 1], yaw: 0, pitch: 0, camera: [14, 4.9, 4.8], target: [9.5, 4.6, -.2] },
  'yard': { label: 'Backyard · fence and trees', player: [-28, 0, -18.5], yaw: 1.57, pitch: -.04, camera: [-25.5, 2, -16], target: [-32.5, 2.4, -10] },
  'spawn-gameplay': { label: 'Spawn · player view', player: [-28, 0, -18.5], yaw: Math.PI / 2, pitch: -.04 },
  // Kannon Town v3: the checkpoint, at standing eye height (1.62 m) like the first-person game.
  'checkpoint-north': { label: 'Checkpoint · from the north end', player: [-3, 0, -21], yaw: 2.8, pitch: -.03, camera: [-3, 1.62, -21], target: [2, 0.9, -9] },
  'checkpoint-south': { label: 'Checkpoint · from the south end', player: [-1, 0, 21], yaw: 0, pitch: -.03, camera: [-1.5, 1.62, 21], target: [1.5, 1.0, 6] },
  'truck': { label: 'Cargo truck · cab and canvas', player: [5.5, 0, -5.5], yaw: 2.8, pitch: -.03, camera: [6.2, 1.62, -6.2], target: [2.6, 1.4, 2.0] },
  'burnt-car': { label: 'Burnt-out car and ammo crates', player: [8.5, 0, -13], yaw: -2.4, pitch: -.05, camera: [8.5, 1.62, -12.5], target: [3.5, 0.7, -17.4] },
  'barrier': { label: 'Concrete barrier · east lane', player: [3, 0, -6], yaw: 2.4, pitch: -.1, camera: [3.2, 1.62, -6.2], target: [6.6, 0.5, -9.5] },
  'yard-sandbags': { label: 'Back yard · sandbag wall', player: [-21, 0, 12], yaw: -1.2, pitch: -.05, camera: [-21.5, 1.62, 12.5], target: [-26.6, 0.6, 8.6] },
  'teal-shadow': { label: 'Street · long shadows', player: [6, 0, 14], yaw: -.4, pitch: -.03, camera: [6.5, 1.62, 15], target: [-2, 1.2, -6] },
  'broken-window': { label: 'Teal house · broken upstairs window', player: [-5.5, 0, 3], yaw: -1.2, pitch: .2, camera: [-5.5, 1.62, 3], target: [-9.75, 5, 0] },
  'yard-crates': { label: 'Back yard · crate stack', player: [-22.6, 0, -11.6], yaw: -.9, pitch: -.1, camera: [-22.6, 1.62, -11.6], target: [-27, 0.6, -15] },
  // Real-time shadows on the bake, seen from a few metres away: a player in the low sun throws a
  // long shadow as dark as the baked shade; a player inside the teal house's shade throws none.
  'sun-shadow': { label: 'Player in the sun · real-time shadow', player: [3.5, 0, -14], yaw: 0.6, pitch: 0, camera: [0.4, 2.4, -10.4], target: [5.4, 0.3, -15.4], showPlayer: true },
  'shade-shadow': { label: 'Player in house shade · no phantom shadow', player: [-6, 0, -1.5], yaw: 0.6, pitch: 0, camera: [-3.1, 2.4, 1.6], target: [-6.4, 0.3, -3.4], showPlayer: true },
};
