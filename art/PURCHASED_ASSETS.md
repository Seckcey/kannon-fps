# Purchased and CC0 assets

Every third-party asset used by Kannon Arena is listed here before it is used. Original
downloads and purchased archives live outside the repository at `C:\it\kannon-assets\<vendor>\`
and are never committed. Only project-specific Blender scenes, converted textures and exported
GLBs are committed.

## Licence rules

A pack or file qualifies only if all of these hold:

- The licence allows use in a distributed game in any engine. CC0, Fab Standard, Unity Asset
  Store EULA, Sketchfab Standard and CGTrader Royalty Free qualify. "Editorial only",
  "personal use only" and share-alike licences do not.
- It ships FBX, OBJ or glTF plus ordinary PBR textures (base colour, normal,
  roughness/metalness or specular). Packs that depend on Unity or Unreal shaders are out.
- Style is stylised realistic. Flat-shaded low-poly (Kenney, Synty) and raw photoscan packs are
  out. Photo textures are acceptable for large surfaces because they are toned and simplified in
  Blender before use.

## Record

Entries are appended as assets are used. `Local path` is where the untouched download lives.

| Vendor | Product | Licence | Obtained | Price | Used for | Local path |
| --- | --- | --- | --- | --- | --- | --- |
| Poly Haven | Textures and models listed in `art/source/town-v2/cc0-manifest.json` | CC0 1.0 (https://polyhaven.com/license) | 2026-09-09 | free | Town v2 surfaces and props | `C:\it\kannon-assets\polyhaven\` |
| ambientCG | Materials listed in `art/source/town-v2/cc0-manifest.json` | CC0 1.0 (https://ambientcg.com/license) | 2026-09-09 | free | Town v2 surfaces and decals | `C:\it\kannon-assets\ambientcg\` |

The manifest records each asset's identifier, source URL, resolution downloaded and SHA-256 of
the downloaded archive, and is written by `scripts/blender/fetch_cc0_assets.mjs`.

## Shortlist to buy (optional upgrade)

The town v2 release is built from the CC0 sources above. These paid packs would replace the
scripted house shells and add more prop variety. Frank buys; the buyer records vendor, product,
order date and price in the table above and stores the archive under `C:\it\kannon-assets\`.

| Need | Candidate marketplaces | Search terms |
| --- | --- | --- |
| Modular suburban house kit | Fab, Unity Asset Store, CGTrader | "modular suburban house stylized", "suburb neighborhood modular" |
| Street and yard props | Fab, Unity Asset Store, Sketchfab | "stylized street props", "suburban props pack" |
| Foliage | Fab, Unity Asset Store | "stylized grass trees pack", "stylized vegetation" |
| Decals | Fab | "decal pack cracks dirt road", "stylized decals" |

A candidate is accepted only after importing into Blender and checking scale (a door about
2.1 m tall), texel density and style against `docs/art/town-graphics-after-street.png`.
