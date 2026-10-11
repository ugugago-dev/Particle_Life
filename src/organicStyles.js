// organic のスタイル表。レンダラ・WGSL・GUI はここから導く (スタイルを足すときはここと compositeWGSL の case だけ)
// fine = スプラット / small / large ぼかしの倍率、params = GUI に出す項目 ('blurLarge' が無ければ large ぼかしを作らない)
// thresholdScale = threshold の倍率 (省略 = 1)、softLarge = large ぼかしを threshold に依存しない整形から作る

const FINE_NONE = { splat: 1, small: 1, large: 1 };

export const ORGANIC_STYLES = {
    glass: {
        index: 1, fine: { splat: 0.3, small: 0.3, large: 1 }, shape: 'nucleus', granules: false, paper: false,
        params: ['coreThreshold', 'blurLarge', 'rimStrength'],
    },
    cell: {
        index: 0, fine: FINE_NONE, shape: 'occupancy', granules: true, paper: true,
        params: ['threshold', 'nucleusThreshold', 'blurLarge', 'speciesTint'],
    },
    scope: {
        index: 2, fine: { splat: 0.4, small: 0.4, large: 1 }, shape: 'occupancy', granules: false, paper: true,
        params: ['threshold', 'blurLarge', 'scopeStain', 'scopeVignette', 'scopeSpeck', 'scopeIsolation'],
        thresholdScale: 1.6, softLarge: true,
    },
};

export const SHAPE_INDEX = { occupancy: 0, nucleus: 1 };
