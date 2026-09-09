import { ARENA_HALF, MAP_NAME, OBSTACLES, SPAWNS, STAIR_ROUTES } from '../../shared/map.js';
process.stdout.write(JSON.stringify({ arenaHalf: ARENA_HALF, name: MAP_NAME, obstacles: OBSTACLES, spawns: SPAWNS, stairs: STAIR_ROUTES }));
