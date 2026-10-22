// Biome tables: terrain shape, palette and scenery mix. Colours are hex (sRGB).

// side: 'none' | 'zig' (mountain wall + drop, flips at hairpins) | 'sea' | 'canyon'
export const BIOMES = {
  forest: {
    hill: 7, wave: 170, micro: 0.35, wallSlope: 0.5, wallCap: 25, dropSlope: 0.5, dropCap: 20, wallStart: 5, side: 'none',
    ground: [0x41622c, 0x547232, 0x3b5026], rock: 0x6f6f68, steep: 0x5b5a50, verge: 0x59492f, offroad: 'grass',
    trees: [['conifer', 1], ['deciduous', 0.12]], treeDens: 24, rockDens: 3, bushDens: 8, treeBand: 70,
  },
  coast: {
    hill: 6, wave: 190, micro: 0.3, wallSlope: 0.55, wallCap: 30, dropSlope: 0.9, dropCap: 60, wallStart: 5, side: 'sea',
    ground: [0x8c8a52, 0x9a9558, 0x6f7a46], rock: 0x9a958a, steep: 0x8a8378, verge: 0x8a7e66, offroad: 'grass',
    trees: [['pine', 0.6], ['cypress', 0.2], ['palm', 0.12]], treeDens: 6, rockDens: 8, bushDens: 16, treeBand: 60,
  },
  alpine: {
    hill: 5, wave: 200, micro: 0.5, wallSlope: 0.85, wallCap: 70, dropSlope: 0.9, dropCap: 70, wallStart: 5, side: 'zig',
    ground: [0x5f7a43, 0x70804e, 0x7b7d57], rock: 0x838078, steep: 0x6e6c66, verge: 0x6e5f48, offroad: 'grass',
    trees: [['conifer', 1]], treeDens: 7, rockDens: 9, bushDens: 3, treeBand: 50,
  },
  desert: {
    hill: 11, wave: 150, micro: 0.4, wallSlope: 0.4, wallCap: 20, dropSlope: 0.4, dropCap: 15, wallStart: 5, side: 'none',
    ground: [0xd0a769, 0xc79a5c, 0xdbb577], rock: 0xa86d48, steep: 0xa5694a, verge: 0xbf9b64, offroad: 'sand',
    trees: [['dead', 0.5], ['palm', 0.06]], treeDens: 1.4, rockDens: 7, bushDens: 6, treeBand: 80,
  },
  ice: {
    hill: 6, wave: 190, micro: 0.4, wallSlope: 0.8, wallCap: 60, dropSlope: 0.9, dropCap: 60, wallStart: 5, side: 'zig',
    ground: [0xdfe8f2, 0xcfdbe9, 0xe8eff7], rock: 0x7d8189, steep: 0x6a6f78, verge: 0xc7d3e0, offroad: 'snow',
    trees: [['snowconifer', 1]], treeDens: 9, rockDens: 5, bushDens: 0, treeBand: 50, snow: 1,
  },
  mud: {
    hill: 6, wave: 150, micro: 0.4, wallSlope: 0.5, wallCap: 20, dropSlope: 0.5, dropCap: 15, wallStart: 5, side: 'none',
    ground: [0x4d6b2e, 0x5a7632, 0x45582b], rock: 0x6a675f, steep: 0x5a4f3d, verge: 0x4a3a28, offroad: 'grass',
    trees: [['deciduous', 1], ['conifer', 0.2]], treeDens: 11, rockDens: 3, bushDens: 16, treeBand: 60, fences: true, hay: true,
  },
  snowforest: {
    hill: 7, wave: 190, micro: 0.35, wallSlope: 0.5, wallCap: 25, dropSlope: 0.5, dropCap: 20, wallStart: 5, side: 'none',
    ground: [0xe9eff6, 0xdbe5ef, 0xf1f5fa], rock: 0x7f838a, steep: 0x9aa3ad, verge: 0xdfe6ee, offroad: 'snow',
    trees: [['snowconifer', 1]], treeDens: 20, rockDens: 2, bushDens: 3, treeBand: 70, snow: 1, banks: true,
  },
  vineyard: {
    hill: 6, wave: 170, micro: 0.3, wallSlope: 0.4, wallCap: 15, dropSlope: 0.4, dropCap: 12, wallStart: 5, side: 'none',
    ground: [0x8c9a4a, 0x9aa552, 0xa4a05c], rock: 0xa09a8c, steep: 0x8f8670, verge: 0x9a8a62, offroad: 'grass',
    trees: [['cypress', 0.6], ['deciduous', 0.5], ['pine', 0.2]], treeDens: 4, rockDens: 1, bushDens: 4, treeBand: 60, vines: true, fences: true,
  },
  canyon: {
    hill: 4, wave: 140, micro: 0.5, wallSlope: 2.2, wallCap: 55, dropSlope: 2.2, dropCap: 55, wallStart: 10, side: 'canyon',
    ground: [0xb4764b, 0xa86a42, 0xc18455], rock: 0xa65a38, steep: 0x8f4a30, verge: 0x9c6a45, offroad: 'sand',
    trees: [['dead', 1]], treeDens: 1, rockDens: 13, bushDens: 3, treeBand: 40,
  },
  highland: {
    hill: 9, wave: 200, micro: 0.5, wallSlope: 0.45, wallCap: 30, dropSlope: 0.5, dropCap: 25, wallStart: 5, side: 'none',
    ground: [0x6b6a43, 0x7a6b4b, 0x5d6a40], rock: 0x7b7a74, steep: 0x625f55, verge: 0x655a40, offroad: 'grass',
    trees: [['deciduous', 0.3], ['conifer', 0.15]], treeDens: 2.5, rockDens: 9, bushDens: 18, treeBand: 80, fences: true, heather: true,
  },
  volcanic: {
    hill: 10, wave: 170, micro: 0.5, wallSlope: 0.6, wallCap: 40, dropSlope: 0.6, dropCap: 30, wallStart: 5, side: 'none', ridged: true,
    ground: [0x2c2c30, 0x38383d, 0x242427], rock: 0x15151a, steep: 0x1d1c20, verge: 0x28282c, offroad: 'ash',
    trees: [['dead', 1]], treeDens: 0.8, rockDens: 12, bushDens: 0, treeBand: 60, lava: true,
  },
};
BIOMES.mixed = BIOMES.forest;

export const SURFACE_COLORS = {
  tarmac: 0x3d3e42, wet: 0x26282c, gravel: 0x8c8174, dirt: 0x7e6044, sand: 0xcdb27c,
  snow: 0xe4edf6, ice: 0xa5d2ea, mud: 0x5a4028, grass: 0x56703a, ash: 0x242427,
};
