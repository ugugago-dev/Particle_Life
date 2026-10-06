// organic 描画のスタイル表 (docs/organic-rendering-spec.md)。レンダラ (パス構成・解像度)、WGSL (style / shape の定数)、
// GUI (選択肢と項目の表示) はここから導く。スタイルを足すときはここと compositeWGSL の case だけ。
//
//   index    : WGSL の style (STYLE_<NAME>)。
//   fine     : スプラット半径 / small ぼかし / large ぼかしの倍率。bands / glass は細かい場でレリーフ・模様を出したいので縮める
//              (large を使わない bands は large を見ない。glass の large は体の輪郭を滑らかにするので縮めない)。
//   shape    : ぼかす前の場の整形 (shapeWGSL)。occupancy = しきい値を超えた分の占有度、compress = 密度の滑らかな圧縮、
//              nucleus = 圧縮した密度が coreThreshold を超えた所 = 核の指標。
//   granules : 顆粒テクスチャ (cell の小器官) を使う。使わないスタイルは顆粒の確保・書き込みを省く。
//   params   : このスタイルが読む「スタイル固有」の config 項目。GUI はこれに含まれる項目だけ表示する。
//              'blurLarge' を含まないスタイルは large ぼかし (と縮小の段) を作らない。

const FINE_NONE = { splat: 1, small: 1, large: 1 };

export const ORGANIC_STYLES = {
    glass: {
        index: 4, fine: { splat: 0.3, small: 0.3, large: 1 }, shape: 'nucleus', granules: false,
        params: ['coreThreshold', 'blurLarge', 'rimStrength'],
    },
    cell: {
        index: 0, fine: FINE_NONE, shape: 'occupancy', granules: true,
        params: ['threshold', 'nucleusThreshold', 'blurLarge', 'speciesTint'],
    },
    glow: {
        index: 1, fine: FINE_NONE, shape: 'occupancy', granules: false,
        params: ['threshold', 'glowIntensity', 'blurLarge', 'speciesTint'],
    },
    bands: {
        index: 2, fine: { splat: 0.6, small: 0.5, large: 1 }, shape: 'compress', granules: false,
        params: ['bandFreq', 'bandBase', 'speciesTint'],
    },
    mono: {
        index: 3, fine: FINE_NONE, shape: 'occupancy', granules: false,
        params: ['threshold', 'blurLarge', 'speciesTint'],
    },
};

export const SHAPE_INDEX = { occupancy: 0, compress: 1, nucleus: 2 };
