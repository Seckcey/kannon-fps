"""Regenerate the scout's shared surface atlas at 2048 x 1024 with real material detail.

The scout GLB maps eight surfaces onto a 4 x 2 grid of tiles (see generate_scout.py
consolidate_surfaces): armor, suit, rubber, gunmetal, steel, bronze, marking, pack teal. Each
mesh part fills its tile, so tile borders are part edges and wear there reads as edge wear.

Writes art/source/town-v2/scout/{Scout_Coating,Scout_MicroNormal,Scout_MetalRoughness}.png;
finish_scout_v2.mjs swaps them into public/models/scout-v2.glb. Pure numpy/PIL, no Blender.
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'art/source/town-v2/scout'
OUT.mkdir(parents=True, exist_ok=True)
TILE = 512
WIDTH, HEIGHT = TILE * 4, TILE * 2
rng = np.random.default_rng(20260910)
yy, xx = np.mgrid[0:TILE, 0:TILE].astype(np.float32)


def clouds(scale, seed):
    """Seamless band-limited noise in [-1, 1]."""
    r = np.random.default_rng(seed)
    freq = np.fft.fftfreq(TILE) * TILE
    falloff = np.exp(-(freq[:, None] ** 2 + freq[None, :] ** 2) / (2 * scale ** 2))
    field = np.fft.ifft2(np.fft.fft2(r.normal(0, 1, (TILE, TILE))) * falloff).real
    return np.clip(field / (field.std() * 2.5 + 1e-6), -1, 1)


def scratches(count, seed, length=(30, 140), width=1.2):
    r = np.random.default_rng(seed)
    mask = np.zeros((TILE, TILE), np.float32)
    for _ in range(count):
        x0, y0 = r.uniform(0, TILE, 2); angle = r.uniform(0, math.pi); n = int(r.uniform(*length))
        dx, dy = math.cos(angle), math.sin(angle)
        for t in range(n):
            x, y = int(x0 + dx * t), int(y0 + dy * t)
            if 0 <= x < TILE and 0 <= y < TILE:
                mask[y, x] = max(mask[y, x], 1.0)
                if width > 1 and 0 <= x + 1 < TILE:
                    mask[y, x + 1] = max(mask[y, x + 1], 0.5)
    return mask


def edge_wear(inset=14, seed=1):
    distance = np.minimum.reduce([xx, yy, TILE - 1 - xx, TILE - 1 - yy])
    band = np.clip(1 - distance / inset, 0, 1) ** 1.6
    return band * (0.55 + 0.45 * np.clip(clouds(9, seed) * 1.4 + 0.3, 0, 1))


def brushed(seed, direction='x', strength=0.06):
    r = np.random.default_rng(seed)
    line = r.normal(0, 1, TILE)
    field = np.tile(line[None, :] if direction == 'y' else line[:, None], (1, TILE) if direction == 'y' else (1, TILE))
    field = np.convolve(field.ravel(), np.ones(3) / 3, mode='same').reshape(TILE, TILE)
    return field * strength


def normal_from_height(height, strength):
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * strength
    n = np.stack([-dx, -dy, np.ones_like(dx)], axis=-1)
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


def tile_armor():
    ivory = np.array([0.70, 0.675, 0.61])
    tone = 1 + clouds(6, 11) * 0.05 + rng.normal(0, 0.006, (TILE, TILE))
    grime = np.clip(clouds(20, 12) * 0.5 + 0.2, 0, 1) * 0.10
    wear = edge_wear(16, 13)
    scratch = scratches(90, 14)
    base = ivory[None, None, :] * tone[..., None]
    base = base * (1 - grime[..., None] * 0.6) - wear[..., None] * 0.28 - scratch[..., None] * 0.12
    rough = 0.36 + clouds(8, 15) * 0.05 + grime * 0.35 + wear * 0.4 + scratch * 0.2
    metal = 0.12 + wear * 0.35
    height = clouds(4, 16) * 0.5 + rng.normal(0, 0.2, (TILE, TILE)) - scratch * 3 - wear * 2
    return base, rough, metal, height, 0.9


def tile_suit():
    charcoal = np.array([0.045, 0.052, 0.058])
    weave = (np.sin(xx * math.pi / 3) * np.sin(yy * math.pi / 3))
    ribs = np.sin(yy * math.pi / 24) * 0.5
    tone = 1 + weave * 0.35 + clouds(12, 21) * 0.12 + ribs * 0.12
    base = charcoal[None, None, :] * tone[..., None]
    rough = 0.86 + weave * 0.05
    metal = np.zeros((TILE, TILE)) + 0.02
    height = weave * 1.2 + ribs * 0.8
    return base, rough, metal, height, 1.4


def tile_rubber():
    dark = np.array([0.03, 0.036, 0.04])
    tone = 1 + clouds(5, 31) * 0.15 + rng.normal(0, 0.03, (TILE, TILE))
    base = dark[None, None, :] * tone[..., None]
    rough = 0.68 + clouds(7, 32) * 0.08
    metal = np.zeros((TILE, TILE)) + 0.04
    height = rng.normal(0, 0.6, (TILE, TILE)) + clouds(3, 33)
    return base, rough, metal, height, 0.7


def tile_metal(colour, seed, roughness, metallic, patina=None, brushed_strength=0.06):
    tone = 1 + brushed(seed, 'x', brushed_strength) + clouds(10, seed + 1) * 0.06
    scratch = scratches(140, seed + 2, (10, 60))
    wear = edge_wear(10, seed + 3)
    base = np.array(colour)[None, None, :] * tone[..., None] * (1 + scratch[..., None] * 0.35) * (1 - wear[..., None] * 0.15)
    rough = roughness + brushed(seed + 4, 'x', 0.05) + scratch * 0.25 + clouds(6, seed + 5) * 0.06
    metal = np.full((TILE, TILE), metallic, np.float32)
    height = brushed(seed + 6, 'x', 1.0) + scratch * -2.0
    if patina is not None:
        spots = np.clip(clouds(14, seed + 7) * 1.6 - 0.35, 0, 1)
        base = base * (1 - spots[..., None]) + np.array(patina)[None, None, :] * spots[..., None]
        rough = rough + spots * 0.4; metal = metal - spots * 0.5
    return base, rough, metal, height, 0.6


def tile_marking():
    paint = np.array([0.88, 0.86, 0.76])
    wear = edge_wear(12, 51); chips = np.clip(clouds(6, 52) * 2.2 - 1.2, 0, 1)
    base = paint[None, None, :] * (1 - chips[..., None] * 0.7 - wear[..., None] * 0.35)
    rough = 0.5 + chips * 0.3 + clouds(8, 53) * 0.05
    metal = 0.02 + chips * 0.3
    height = -chips * 3 + rng.normal(0, 0.2, (TILE, TILE))
    return base, rough, metal, height, 0.8


def tile_pack_teal():
    teal = np.array([0.02, 0.12, 0.13])
    tone = 1 + clouds(8, 61) * 0.12 + rng.normal(0, 0.01, (TILE, TILE))
    scratch = scratches(60, 62); wear = edge_wear(12, 63)
    base = teal[None, None, :] * tone[..., None] + wear[..., None] * np.array([0.25, 0.25, 0.24])[None, None, :] * 0.35 + scratch[..., None] * 0.08
    rough = 0.42 + wear * 0.3 + scratch * 0.2 + clouds(7, 64) * 0.05
    metal = 0.3 + wear * 0.4
    height = clouds(4, 65) * 0.4 - scratch * 2.5 - wear * 1.5
    return base, rough, metal, height, 0.8


TILES = [
    tile_armor(),
    tile_suit(),
    tile_rubber(),
    tile_metal((0.05, 0.058, 0.062), 41, 0.34, 0.8),                       # gunmetal
    tile_metal((0.30, 0.33, 0.34), 71, 0.30, 0.85, brushed_strength=0.09),  # brushed titanium
    tile_metal((0.40, 0.20, 0.06), 81, 0.33, 0.8, patina=(0.20, 0.36, 0.32)),  # warm bronze
    tile_marking(),
    tile_pack_teal(),
]

coating = np.zeros((HEIGHT, WIDTH, 3), np.float32)
normal = np.zeros((HEIGHT, WIDTH, 3), np.float32); normal[..., 2] = 1.0; normal[..., :2] = 0.5
orm = np.ones((HEIGHT, WIDTH, 3), np.float32)
for index, (base, rough, metal, height, normal_strength) in enumerate(TILES):
    y, x = (index // 4) * TILE, (index % 4) * TILE
    coating[y:y + TILE, x:x + TILE] = np.clip(base, 0, 1)
    orm[y:y + TILE, x:x + TILE, 1] = np.clip(rough, 0.04, 1)
    orm[y:y + TILE, x:x + TILE, 2] = np.clip(metal, 0, 1)
    normal[y:y + TILE, x:x + TILE] = normal_from_height(height, normal_strength)


def srgb(linear):
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(np.clip(linear, 0, 1), 1 / 2.4) - 0.055)


def save(name, array, colour):
    data = srgb(array) if colour else array
    # Blender-style bottom-up rows to PNG top-down rows.
    image = Image.fromarray((np.clip(data, 0, 1)[::-1] * 255 + 0.5).astype(np.uint8), 'RGB')
    image.save(OUT / f'{name}.png', optimize=True)
    print(f'{name}: {image.size[0]}x{image.size[1]}')


save('Scout_Coating', coating, True)
save('Scout_MicroNormal', normal, False)
save('Scout_MetalRoughness', orm, False)
