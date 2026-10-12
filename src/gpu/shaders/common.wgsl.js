// シミュレーション共通の WGSL。Params はスカラーだけにしてアライメントを気にしなくてよくしてある (並びの一致は assertParamsLayout)

export const PARAMS_STRUCT_FIELDS = [
    'dt', 'rMax2', 'invRMax', 'beta', 'invBeta', 'invOneMinusBeta', 'accelScale', 'friction',
    'worldW', 'worldH', 'invCellW', 'invCellH', 'nx', 'ny', 'nCells', 'numParticles',
    'numTypes', 'pointerActive', 'pointerX', 'pointerY', 'pointerR2', 'invPointerR', 'pointerStrength', 'rMax',
    'reach', 'maxSpeed', 'restDensity', 'pressureScale', 'viscosity', 'pad0', 'pad1', 'pad2',
];
export const PARAMS_FLOATS = PARAMS_STRUCT_FIELDS.length;

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
  pointerStrength: f32,   // mode * pointerStrength * forceFactor
  rMax: f32,
  reach: u32,             // 近傍探索の K (±K セル)
  maxSpeed: f32,          // 0 = 無制限
  restDensity: f32,
  pressureScale: f32,     // 0.5 * pressureStrength
  viscosity: f32,
  pad0: f32,              // 16 バイト境界
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> P: Params;

// x-major (CPU 版 cpuSimulation.js と同じ)。min は丸めで x == worldW になったときの保険
fn cellIndex(x: f32, y: f32) -> u32 {
  let cx = min(P.nx - 1u, u32(x * P.invCellW));
  let cy = min(P.ny - 1u, u32(y * P.invCellH));
  return cx * P.ny + cy;
}

// [0, size) に巻き戻す (CPU 版 wrap と同じ)
fn wrapPos(v: f32, size: f32) -> f32 {
  var q = v;
  if (q < 0.0 || q >= size) {
    q = q - size * floor(q / size);
  }
  // 丸めの保険
  if (q >= size) { q = 0.0; }
  if (q < 0.0) { q = 0.0; }
  return q;
}
`;

/** WGSL の struct と JS 側のフィールド順の食い違い (値が黙ってずれる) を起動時に検出する。 */
export function assertStructLayout(source, structName, fields) {
    const body = new RegExp(`struct ${structName} \\{([^}]*)\\}`).exec(source)?.[1] ?? '';
    const names = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
    if (names.join() !== fields.join()) {
        throw new Error(`${structName} struct (WGSL) and its JS field list are out of sync:\n${names.join()}\n${fields.join()}`);
    }
}

export function assertParamsLayout() {
    assertStructLayout(COMMON_WGSL, 'Params', PARAMS_STRUCT_FIELDS);
}
