// 全シミュレーションパスで共有する WGSL (uniform 構造体とヘルパー)。
//
// Params は f32 / u32 のスカラーだけで構成する (vec を使わない) ので、
// WGSL の uniform アライメント規則 (vec2=8, vec4=16 バイト境界) を気にしなくてよい。
// 全体で 28 個 = 112 バイト (16 の倍数)。JS 側 (simulation.js の writeUniforms) と
// フィールド順を必ず一致させること。
//
// 座標系: ワールドは [0, worldW) x [0, worldH) のトーラス (worldH = 1)。
// セル番号は CPU 版 grid.js と同じ x-major:  cell = cx * ny + cy

export const PARAMS_STRUCT_FIELDS = [
    'dt', 'rMax2', 'invRMax', 'beta', 'invBeta', 'invOneMinusBeta', 'accelScale', 'friction',
    'worldW', 'worldH', 'invCellW', 'invCellH', 'nx', 'ny', 'nCells', 'numParticles',
    'numTypes', 'pointerActive', 'pointerX', 'pointerY', 'pointerR2', 'invPointerR', 'pointerStrength', 'rMax',
    'reach', 'maxSpeed', 'restDensity', 'pressureScale',
];
export const PARAMS_FLOATS = PARAMS_STRUCT_FIELDS.length; // 28

export const COMMON_WGSL = /* wgsl */`
struct Params {
  dt: f32,
  rMax2: f32,
  invRMax: f32,
  beta: f32,
  invBeta: f32,
  invOneMinusBeta: f32,
  accelScale: f32,        // rMax * forceFactor
  friction: f32,          // 0.5 ^ (dt / halfLife)
  worldW: f32,
  worldH: f32,
  invCellW: f32,          // nx / worldW
  invCellH: f32,          // ny / worldH
  nx: u32,
  ny: u32,
  nCells: u32,
  numParticles: u32,
  numTypes: u32,
  pointerActive: u32,
  pointerX: f32,
  pointerY: f32,
  pointerR2: f32,
  invPointerR: f32,
  pointerStrength: f32,   // mode * pointerStrength * forceFactor (0 when inactive)
  rMax: f32,
  reach: u32,             // 近傍探索のセル数 K (セル幅 >= rMax / K、探索は ±K セル)
  maxSpeed: f32,          // 速度の上限 (ワールド単位 / 秒)。0 = 無制限
  restDensity: f32,       // これを超えた密度の分だけ圧力がかかる
  pressureScale: f32,     // 0.5 * pressureStrength (0 = 圧力なし)
};

@group(0) @binding(0) var<uniform> P: Params;

// 位置 -> セル番号 (CPU 版 grid.build と同じ式)。
// min は float の丸めで x == worldW になったときの保険。
fn cellIndex(x: f32, y: f32) -> u32 {
  let cx = min(P.nx - 1u, u32(x * P.invCellW));
  let cy = min(P.ny - 1u, u32(y * P.invCellH));
  return cx * P.ny + cy;
}

// v を [0, size) に巻き戻す (CPU 版 wrap と同じ。結果は必ず 0 <= q < size)。
fn wrapPos(v: f32, size: f32) -> f32 {
  var q = v;
  if (q < 0.0 || q >= size) {
    q = q - size * floor(q / size);
  }
  // 丸めで q == size や q < 0 (-1e-9 級) になる場合の保険
  if (q >= size) { q = 0.0; }
  if (q < 0.0) { q = 0.0; }
  return q;
}
`;

/**
 * WGSL の struct Params と JS 側の PARAMS_STRUCT_FIELDS (writeUniforms が書く順) が
 * 食い違っていないか、起動時に確認する (食い違うと値が黙ってずれるため)。
 */
export function assertParamsLayout() {
    const body = /struct Params \{([^}]*)\}/.exec(COMMON_WGSL)?.[1] ?? '';
    const names = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
    if (names.join() !== PARAMS_STRUCT_FIELDS.join()) {
        throw new Error(`Params struct (WGSL) and PARAMS_STRUCT_FIELDS (JS) are out of sync:\n${names.join()}\n${PARAMS_STRUCT_FIELDS.join()}`);
    }
}
