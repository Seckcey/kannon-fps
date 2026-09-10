/** Project glTF extension carrying a baked lightmap per material.
 *
 *  materials[i].extensions.KANNON_lightmap = { intensity, texture: { index, texCoord } }
 *
 *  The runtime reader lives in src/game/Lightmaps.ts. This module mirrors the structure of
 *  gltf-transform's own texture-bearing material extensions (KHR_materials_clearcoat). */
import { Extension, ExtensionProperty, PropertyType, TextureChannel, TextureInfo } from '@gltf-transform/core';

export const LIGHTMAP_EXTENSION = 'KANNON_lightmap';
const { R, G, B } = TextureChannel;

export class Lightmap extends ExtensionProperty {
  static EXTENSION_NAME = LIGHTMAP_EXTENSION;
  init() { this.extensionName = LIGHTMAP_EXTENSION; this.propertyType = 'Lightmap'; this.parentTypes = [PropertyType.MATERIAL]; }
  getDefaults() { return Object.assign(super.getDefaults(), { intensity: 1, texture: null, textureInfo: new TextureInfo(this.graph, 'textureInfo') }); }
  getIntensity() { return this.get('intensity'); }
  setIntensity(value) { return this.set('intensity', value); }
  getTexture() { return this.getRef('texture'); }
  setTexture(texture) { return this.setRef('texture', texture, { channels: R | G | B }); }
  getTextureInfo() { return this.getRef('texture') ? this.getRef('textureInfo') : null; }
}

export class KannonLightmap extends Extension {
  static EXTENSION_NAME = LIGHTMAP_EXTENSION;
  extensionName = LIGHTMAP_EXTENSION;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  createLightmap() { return new Lightmap(this.document.getGraph()); }
  read() { return this; }
  write() { return this; }
  preread(context) {
    const json = context.jsonDoc.json;
    const textureDefs = json.textures ?? [];
    (json.materials ?? []).forEach((materialDef, index) => {
      const def = materialDef.extensions?.[LIGHTMAP_EXTENSION];
      if (!def) return;
      const lightmap = this.createLightmap();
      if (def.extras) lightmap.setExtras(def.extras);
      if (def.intensity !== undefined) lightmap.setIntensity(def.intensity);
      if (def.texture !== undefined) {
        lightmap.setTexture(context.textures[textureDefs[def.texture.index].source]);
        context.setTextureInfo(lightmap.getTextureInfo(), def.texture);
      }
      context.materials[index].setExtension(LIGHTMAP_EXTENSION, lightmap);
    });
    return this;
  }
  prewrite(context) {
    const json = context.jsonDoc.json;
    for (const material of this.document.getRoot().listMaterials()) {
      const lightmap = material.getExtension(LIGHTMAP_EXTENSION);
      if (!lightmap) continue;
      const materialDef = json.materials[context.materialIndexMap.get(material)];
      const def = context.createPropertyDef(lightmap);
      def.intensity = lightmap.getIntensity();
      if (lightmap.getTexture()) def.texture = context.createTextureInfoDef(lightmap.getTexture(), lightmap.getTextureInfo());
      materialDef.extensions ??= {};
      materialDef.extensions[LIGHTMAP_EXTENSION] = def;
    }
    return this;
  }
}
