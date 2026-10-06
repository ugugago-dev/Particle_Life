// organic のスタイル表。レンダラ・WGSL・GUI はここから導く (スタイルを足すときはここと compositeWGSL の case だけ)
// fine = スプラット / small / large ぼかしの倍率、params = GUI に出す項目 ('blurLarge' が無ければ large ぼかしを作らない)

const FINE_NONE = { splat: 1, small: 1, large: 1 };

export const ORGANIC_STYLES = {
    glass: {
        index: 4, fine: { splat: 0.3, small: 0.3, large: 1 }, shape: 'nucleus', granules: false, paper: false,
        params: ['coreThreshold', 'blurLarge', 'rimStrength'],
    },
    cell: {
        index: 0, fine: FINE_NONE, shape: 'occupancy', granules: true, paper: true,
        params: ['threshold', 'nucleusThreshold', 'blurLarge', 'speciesTint'],
    },
    glow: {
        index: 1, fine: FINE_NONE, shape: 'occupancy', granules: false, paper: false,
        params: ['threshold', 'glowIntensity', 'blurLarge', 'speciesTint'],
    },
    bands: {
        index: 2, fine: { splat: 0.6, small: 0.5, large: 1 }, shape: 'compress', granules: false, paper: false,
        params: ['bandFreq', 'bandBase', 'speciesTint'],
    },
    mono: {
        index: 3, fine: FINE_NONE, shape: 'occupancy', granules: false, paper: false,
        params: ['threshold', 'blurLarge', 'speciesTint'],
    },
};

export const SHAPE_INDEX = { occupancy: 0, compress: 1, nucleus: 2 };
