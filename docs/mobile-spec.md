# スマホ版 (JS シミュレーション + WebGL2 描画) 仕様書

PC 版 (WebGPU compute + WebGPU 描画) と同じ Particle Life を、WebGPU 非対応・GPU が弱いスマホで動かす。
**シミュレーションは CPU (JS、メインスレッド)、描画は WebGL2。** 入口は `mobile.html`。PC 版 (`index.html` / `src/gpu/**` / `src/main.js`) は変更しない (例外: 「PC 版への変更」の節)。

このファイルは実装担当のエージェント全員が読む共通の仕様。担当ファイルは「担当」の節で固定してあり、**他人のファイルは編集しない**。

## 方針

- v1 はメインスレッド 1 本。Worker / SharedArrayBuffer は使わない (COOP/COEP ヘッダを静的ホスティングで付けられないため)。まず実測する。
- 描画は phase 1 = dots / trails / ポインタ円。organic は phase 2 (後述、能力チェックつき)。**スマホでは `renderMode` の既定は `dots`**。
- 物理は PC 版 (WGSL) と同じ。ただしスマホ用の既定値 (粒子数・rMax) を持つ。
- 外部ライブラリは使わない (`?advanced` の調整パネルも自作の `src/ui/panel.js`。PC 版と共通)。

## ファイルと担当

| ファイル | 内容 | 担当 |
|---|---|---|
| `src/mobile/cpuSimulation.js` | CPU シミュレーション (DOM 非依存) | Opus |
| `tests/cpuSimulation.test.mjs` | 近傍探索を総当たりと比較する Node テスト (依存なし。`node tests/cpuSimulation.test.mjs`) | Opus |
| `src/mobile/glRenderer.js` | WebGL2 描画 (dots / trails / ポインタ円) | Sonnet |
| `src/ui/matrixEditor.js` + `style.css` の matrix 部分 | タッチ操作の追加 (PC のマウス操作は挙動不変) | Sonnet |
| `mobile.html`, `mobile.css`, `src/mobile/mobileGui.js` | ページ・スマホ用 CSS・`?advanced` 用 GUI | Haiku |
| `src/gpu/device.js` の `showUnsupported` | `mobile.html` へのリンクを足す | Haiku |
| `src/mobile/main.js` | 結線 (最後に作る) | Sonnet |

そのまま import して使う (変更しない): `src/config.js` `src/rules.js` `src/particles.js` (`wrap` / `alloc` / `randomize`) `src/presets.js` `src/palette.js` `src/input.js`。

## 世界と単位 (PC 版と同じ)

高さ = 1、幅 = canvas のアスペクト比 `A = cssW / cssH`、周期境界。時間は秒。`params` は `createParams()` が返す config.js の object。ルールは `RuleMatrix` (`data[i * numTypes + j]`、行 i が列 j に引かれる)。

## CpuSimulation (`src/mobile/cpuSimulation.js`)

```js
export class CpuSimulation {
  // 公開 (renderer が読む。SoA、容量 = count ちょうど)
  count; numTypes; world /* {width, height} */;
  x; y; vx; vy;   // Float32Array
  type;           // Uint8Array
  grid;           // {nx, ny, nCells, reach} デバッグ表示用

  setWorld(width, height = 1)           // 範囲外の粒子は wrap で戻す
  setRules(rules)                       // RuleMatrix をコピーして持つ (呼び出しごとに data を読み直してよい)
  randomize(count, numTypes, rng = Math.random)   // 位置は一様、速度 0、type は i.i.d.
  assignTypes(numTypes, rng = Math.random)        // type だけ振り直す
  setCount(n, rng = Math.random)        // 先頭の粒子を保持して増減 (増えた分はランダム配置)
  step(params, pointer, steps)          // dt = params.dt で steps 回進める (steps = 0 は何もしない)
}
```

DOM / window / performance を参照しない (Node で動かす)。

### 物理 (正) = `src/gpu/shaders/force.wgsl.js` + `src/gpu/simulation.js` の `writeUniforms`

1 ステップは次の順。**全員が古い位置から力を受ける** (GPU 版は並べ替えたコピー B を読んで A に書く)。粒子を逐次更新して新しい位置を近傍が読む実装は動力学が変わるので不可。

1. セルに振り分けて並べ替える (counting sort。pos / vel / type の並べ替えコピーを作る)。
2. 圧力ありのとき (`limitPressure && pressureStrength > 0`): 古い位置から全粒子の `ρ_i = Σ_j q²` (`q = 1 - d / rMax`、`d < rMax` かつ `d > 0` の近傍 j) を求め、`P_i = max(0, ρ_i - restDensity)`。**force より前に、同じステップの位置で**。
3. 全粒子の加速度 → 速度 → 位置を、古い値だけから計算して書き込む。

力 (粒子 i が近傍 j から受ける。`(dx, dy)` は i から j への最小イメージの変位、`d2 = dx² + dy²`、`d2 >= rMax²` または `d2 == 0` は無視):

```
r = d / rMax
f = r < beta ? r / beta - 1                                   // 斥力 (普遍)
             : rules[ti][tj] * (1 - |2r - 1 - beta| / (1 - beta))
(圧力あり)  f -= pressureScale * (P_i + P_j) * (1 - r)         // pressureScale = 0.5 * max(pressureStrength, 0)
(粘性あり)  f += viscosity * (1 - r) * min(P_i + P_j, 1) * ((vj - vi) · (dx, dy)) / d
acc += (dx, dy) / d * f
```

- `beta = clamp(params.beta, 0, 0.999)`。`beta == 0` のとき `r < beta` は常に偽。
- 粘性は `limitPressure` が真のときだけ有効で、`viscosity = clamp(params.viscosity, 0, 0.01 / (rMax * forceFactor * dt))` (MAX_VISCOSITY_STEP = 0.01)。圧力が無効なら粘性も無効。速度は古い値 (ステップ開始時)。
- `accelScale = rMax * forceFactor`、`a = acc * accelScale`。
- ポインタ (`pointer.active`): `(dx, dy)` = ポインタ - 自分 (最小イメージ)。`d2 < pointerRadius²` かつ `d2 > 1e-12` のとき `w = 1 - d / pointerRadius`、`a += (dx, dy) / d * (pointer.mode * pointerStrength * forceFactor * w² (3 - 2w))`。力は粒子間の力に負けないよう forceFactor を掛ける。
- 積分: `friction = 0.5 ** (dt / max(frictionHalfLife, 1e-6))`、`v = v * friction + a * dt`。`limitSpeed && maxSpeed > 0` のとき `|v| > maxSpeed` なら `|v| = maxSpeed` に縮める。`pos = wrap(pos + v * dt)` (`particles.js` の `wrap`、float32 に丸めても範囲内)。

### 近傍探索

- 一様グリッド、セル幅 ≥ `rMax`、`nx = max(3, floor(width / rMax))` (`ny` も同様)。`rMax` / world が変わったときだけ作り直す。セル数の上限を設け (例 `1 << 20`)、超えたらセルを大きくする。
- 各粒子は自分のセルと周囲 8 セルを走査 (周期境界は変位に ±world を足して最小イメージ)。`nx, ny >= 3` なので同じセルを 2 回見ない。
- 割り当てを毎ステップ増やさない (typed array を使い回す)。内側ループは SoA の並べ替えコピー (`sx, sy, svx, svy, stype`) を連続して読む。
- 性能が出るなら対称ペア (i, j を 1 回だけ評価して両方に足す) にしてよい。ただし `rules[ti][tj]` と `rules[tj][ti]` は別なので、ペアごとに両方向の `f` を計算すること。結果が上の式と一致するのが条件。

### テスト (`tests/cpuSimulation.test.mjs`)

- 小さい N (例 300) / 乱数 (seed つき) / 複数の type で、1 ステップ後の位置・速度を **O(N²) 総当たり** (最小イメージで全ペア) と比較。許容誤差は float32 相当 (相対 1e-4 程度)。
- 圧力あり・粘性あり・ポインタあり・`beta = 0`・縦長の world (A = 0.46) を含める。
- 周期境界をまたぐペア (端に置いた 2 粒子) が引き合うこと。
- 失敗したら終了コード 1。

## GlRenderer (`src/mobile/glRenderer.js`)

```js
export class GlRenderer {
  static create(canvas)                  // WebGL2 が無ければ throw。{alpha:false, antialias:false, powerPreference:'high-performance'}
  resize(cssW, cssH, dpr)                // 実 dpr は min(dpr, MAX_DPR = 2)。canvas.width/height を設定し viewport 更新
  draw(sim, view)                        // 1 フレーム描画
  setContextLostHandler(fn)              // webglcontextlost / restored。restored 後は GL 資源を作り直して描画を続ける
  dispose()
  capabilities                           // { halfFloatRT, floatBlend, maxTextureSize } phase 2 の判定用
}
// view = { palette /* createPalette の戻り値 */, particleRadius /* CSS px */, trails /* boolean */,
//          pointer /* input.js の pointer */, pointerRadius /* world 単位 */,
//          renderMode /* 'dots' | 'organic' */, organic /* params (phase 2) */ }
```

- 粒子は **instanced quad** (`gl.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count)`)。instance 属性 = `(x, y, type)` の interleaved Float32Array を 1 本の VBO に毎フレーム `bufferSubData` (容量は粒子数が増えたときだけ作り直す。`sim.x/y/type` から scratch に詰める。確保は使い回す)。
- 見た目は `src/gpu/shaders/render.wgsl.js` の dots と同じ: 半径 `particleRadius * dpr` px + AA 1px の円、色は palette (`MAX_PALETTE = 16` の uniform 配列、ガンマ空間の値をそのまま書く。canvas は非 sRGB)、背景 `rgb(1, 14, 29)`。
- ポインタ円も同じ (`pointerWGSL` 参照: 塗り alpha 0.08 + 線 0.9、引力 `(80,255,140)` / 斥力 `(255,90,80)`、周期境界のため 3x3 コピー)。`pointer.active` のときだけ。
- trails: オフスクリーン FBO (RGBA8) に「背景色 alpha = fade の全画面 → 粒子」を積み、毎フレーム canvas に blit。fade 値と挙動は `src/gpu/renderer.js` の `fade` を読んで合わせる。`trails` が偽の間は FBO を持たない / 描かない。
- 帯域の節約: 状態が変わらない描画 (`running = false`) でも毎フレーム描いてよいが、不要な GL 呼び出しは避ける。`gl.clear` は使わない場面で呼ばない。
- phase 1 では `view.renderMode === 'organic'` を渡されたら dots にフォールバックする (`capabilities` は埋める)。

## 既定値 (スマホ用)

`createParams()` の後に `mobile/main.js` が上書きする。

| 項目 | 値 | 理由 |
|---|---|---|
| `renderMode` | `'dots'` | phase 1。organic は phase 2 |
| `numParticles` | 2500 | CPU の予算。Node 計測で N=4000 はクラスタ形成後 15〜20 ms/step (デスクトップ級 CPU) なので、スマホは 2500 から。ペア評価数は `N × 94` ほど (下記) |
| `rMax` | `sqrt(30 * A / N)` | 近傍密度を PC 版と同じにする (下記) |
| `substeps` | 1 | |
| `particleRadius` | 1.6 (CSS px) | |
| `showMatrix` | `false` | 画面が狭い。ボタンで開く |
| `dt`, `frictionHalfLife`, `forceFactor`, `maxSpeed`, `pressureStrength` ほか | config.js の既定のまま | 見た目の速さを PC 版と揃える |

**密度の不変量は `N * rMax² / A ≈ 30`** (PC 版 60000 粒子・rMax 0.03・16:9 → 30.3)。`config.js` のコメントの `N * rMax²` は 16:9 の `A` を暗黙に含んでいる。縦長のスマホ (A ≈ 0.46) で rMax を固定すると近傍密度が 3.9 倍になり、遅く、見た目も変わる。
このとき近傍数は `N π rMax² / A = 30π ≈ 94` で一定。ペア評価は 1 ステップ ~ `94 N` (グリッドの走査分で 1.5〜2 倍)。N = 2500 で約 24 万ペア。

- N は固定、**rMax をアスペクト比に合わせて決め直す**: 起動時と、`A` が 20% 以上変わったとき (回転)。`rMax` を変えたら GUI の表示も更新し、粒子は wrap で世界に収める (リセットしない)。
- `restDensity` は絶対値 (重み付き近傍数) で、上の不変量を守っている限り PC 版と同じ意味になる。
- `?n=` (粒子数) と `?preset=` (1 始まり。PC 版と同じ) を URL から読む。
- 自動品質 (必須): 直近 2 秒の平均フレーム時間が 20 ms を超えたら `sim.setCount(round(N * 0.8))` で N を減らす (下限 1000)。1 回の起動で上げ方向には戻さない。`?n=` 指定時は無効。

## 操作 (タッチ)

- キャンバスは `src/input.js` をそのまま使う (1 本目の指が引力)。
- **斥力はボタンで切り替え**: 画面下のツールバーに `引く / 押す` のトグル。`input.js` は触らず、`mobile/main.js` で canvas の `pointerdown` / `pointermove` を `createInput` の**後に**登録し、`pointer.mode` を上書きする (リスナーは登録順に動く)。
- ツールバー (画面下、親指の届く位置、`env(safe-area-inset-bottom)` を考慮): `⏯` 実行/停止、`引く/押す`、`ルール` (ルール行列の開閉)、`🎲` ルールをランダム、`↺` 粒子リセット、プリセット `<select>`。ボタンは 44 px 以上。
- ルール行列: タッチで **タップ = +0.1、長押し (500 ms) = −0.1**、**ダブルタップ = 0**。PC のマウス (クリック・右クリック・ホイール・shift+クリック) は従来どおり。長押しのあとの click は無視する。セルは表示上 ≥ 28 px にする (`--cell`)。
- `visibilitychange` で hidden の間は rAF を止め、戻ったら再開 (経過時間は捨てる。ステップは rAF ごとに固定 `substeps` で、可変にしない)。
- `touch-action: none`、`user-select: none`、ピンチズーム・ダブルタップズーム無効 (`viewport` に `user-scalable=no, viewport-fit=cover`)、`overscroll-behavior: none`。
- `?advanced` のとき調整パネル (`src/ui/panel.js`、既定で閉じる) に最小限のパラメータを出す (`src/mobile/mobileGui.js`、下記)。

### `src/mobile/mobileGui.js`

```js
export function createMobileGUI(params, actions)   // src/ui/panel.js の Panel を返す
// actions = { setNumParticles(n), setNumTypes(n), recomputeRMax(), resetParticles(), copyRules() }
```

出す項目: `numParticles` (500〜20000, step 500, 離したとき)、`numTypes` (1〜12)、`ruleGenerator` (`random rules`: lifelike / uniform)、`rMax` (0.02〜0.25)、`forceFactor`、`frictionHalfLife`、`dt`、`substeps` (1〜4)、`particleRadius` (0.5〜6)、`trails`、`pointerRadius`、`pointerStrength`、`limitPressure` / `pressureStrength`、`viscosity`、`Copy rules`。

## mobile/main.js の結線

PC 版の `src/main.js` と同じ構成 (`params` / `RuleMatrix` / `palette` / `MatrixEditor`)。違い:

- `CpuSimulation` + `GlRenderer`。WebGL2 が無ければメッセージを出して終わる (`showUnsupported` と同じ体裁。文言は「このブラウザは WebGL2 に対応していません」)。
- rAF ごとに `sim.step(params, pointer, params.running ? params.substeps : 0)` → `renderer.draw(sim, view)`。`rulesDirty` なら `sim.setRules(rules)`。
- `renderer.resize` は `ResizeObserver` と `window.resize` と `orientationchange` から。
- `?advanced` のとき `stats.js` のオーバーレイ (`StatsOverlay`) を使う場合は `new StatsOverlay(false)`、`recordGpu` は呼ばない。`sim` 時間 (`performance.now()` 差) を `recordCpu` に渡し、`grid` の情報を `tick` の第 3 引数に。
- ポインタの座標は `input.js` の `world` 単位 (高さ = 1) でそのまま `sim.step` に渡る。

## 振り分け (決定)

スマホ / タブレット (UA が Android / iPhone / iPad / iPod、または iPadOS の Macintosh + タッチ) は WebGPU が使える端末でも**常に `mobile.html`**。`index.html` の先頭の inline script が `location.replace('mobile.html' + location.search)` する。`?desktop` を付けると PC 版を強制。

## phase 2: organic (WebGL2 の簡易版)。実装する (担当 Opus: `src/mobile/organicGl.js`。`glRenderer.js` はそれを呼ぶ薄い分岐だけ足す)

- `view.renderMode === 'organic'` かつ `capabilities` が満たされるとき `organicGl` で描く。満たされなければ dots。`mobile/main.js` は能力があれば既定を `organic`、ツールバーに `点 / 有機` のトグルを持つ (担当: 統括)。

PC 版の organic (`docs/organic-rendering-spec.md`) は WebGPU の MRT・rgba16float・分離ガウスの多段パス。スマホ版は同じ見た目 (特に既定の `glass`) を、次の簡略で作る。

- 能力チェック: `EXT_color_buffer_half_float` (または `EXT_color_buffer_float`) と、float への加算ブレンド (`EXT_float_blend`。rgba16f は標準で blend 可)。無ければ organic の選択肢を出さず dots のまま。
- field は `rgba16f`、解像度 = canvas の 1/4 (`fieldScale = 0.25`)。splat は instanced quad の加算ブレンド。周期境界は余白方式でなく **ラップ用のコピー描画** (端から splat 半径以内の粒子だけ ±world でもう一度描く) でよい。
- ぼかしは分離ガウス (水平→垂直) を small / large の 2 本、タップは 9〜13 (バイリニア 2 テクセルまとめ)。σ が大きいときは縮小してから。
- 着色は `glass` のみ (cell / scope は作らない)。composite の式は `src/gpu/shaders/organic.wgsl.js` の glass の部分を GLSL ES 3.00 へ移植する。
- 目標: 4000 粒子で field + blur + composite が中位機 (Pixel 6 級) で 4 ms 以下。超えるなら `fieldScale` を下げる。

## PC 版への変更 (最小)

- `showUnsupported` (`src/gpu/device.js`): 「スマホ版 (WebGL2) を開く」リンクを `mobile.html` へ足す。挙動は変えない。
- `style.css` の matrix 部分はタッチの追加のみ。マウスの見た目・挙動は不変。

## 検証 (統合後に全員の成果物をまとめて確認する)

1. `node tests/cpuSimulation.test.mjs` が通る。
2. `python3 -m http.server` で配信し、Playwright の Chromium (iPhone 相当のエミュレーション + タッチ) で `mobile.html?advanced` を開く。コンソールエラー 0、スクリーンショットで粒子が描かれ、構造 (クラスタ) ができている。
3. CDP の CPU スロットル 4x で 4000 粒子の 1 フレームの時間を測る。目標は実機換算で 16 ms 以下 (=スロットル下で ~ 60 ms 以内を目安)。
4. 縦向き (390x844)・横向き (844x390) の両方で `rMax` が `sqrt(30 A / N)` に追従する。
5. PC 版 `index.html` が従来どおり (WebGPU が無い環境ではメッセージにリンクが出る)。

## 最適化 (担当 Opus: `cpuSimulation.js`、新規 `simWorker.js` / `simClient.js`、テスト、`tests/bench.mjs`)

目標: 同じ物理 (総当たりテストが通る) のまま、N=4000・クラスタ形成後 (現状 Node で 15〜20 ms/step) を大きく速くする。必ず**計測してから**入れ、効いたものだけ残す。候補:

- 計算の統合・削減: density と force のループ統合 (圧力が効かない粒子の省略など、結果が変わらない範囲で)、`rules` の行を事前に取り出す、ペアごとの除算・sqrt の削減、`d2 >= rMax²` の早期棄却を先頭に。
- メモリ: 並べ替えコピーの Float64 → Float32 (精度は許容誤差内か確認)、ライブ配列自体をセル順に定期的に並べ替えて局所性を上げる (粒子 id は保つ)、前フレームの並びから差分で再ソート。
- Worker 化 (SharedArrayBuffer は使わない): シミュレーションを Worker で回し、位置・type の snapshot を **transferable な ArrayBuffer を往復** させて main に渡す (ダブル / トリプルバッファ)。`SimClient` は `CpuSimulation` と同じ公開面 (`count, numTypes, world, x, y, type, grid, setWorld, setRules, randomize, assignTypes, setCount, step`) を持ち、`step` は Worker へ非同期に依頼するだけで即座に返り、`x/y/type` は最新の完了 snapshot を指す。main の描画が sim 待ちで止まらないこと。Worker が使えない環境では `CpuSimulation` に自動で戻す (`createSim()` を `simClient.js` から export し、main.js はそれだけ呼ぶ)。
- 検証: `tests/cpuSimulation.test.mjs` が通ること。`tests/bench.mjs` に、最適化前後を比べる計測 (一様 / 500 ステップ後、A = 0.46 / 1.78、N = 2500 / 4000) を残す。

報告に before / after の表を付ける。

## UI の練り直し (担当 Sonnet: `src/mobile/main.js`、`mobile.html`、`mobile.css`、`src/mobile/mobileGui.js`、`src/ui/matrixEditor.js` と `style.css` の matrix 部分、新規 `src/mobile/ui/*.js`)

画面は「粒子が主役」。操作は親指だけで完結し、既定では最小限の UI だけを出す。

- **ツールバー**: 絵文字 / 文字でなく **インライン SVG のアイコン** (再生/停止、引く/押す、ルール、設定)。ラベルは小さく併記。主操作は 4〜5 個まで。`引く/押す` はポインタ円と同じ色 (緑 / 赤) で状態が分かる。
- **ボトムシート**: `ルール` と `設定` は画面下から出るシート (ドラッグで閉じる、背景タップで閉じる、`prefers-reduced-motion` を尊重)。シートの高さは内容に応じ、画面の 60% まで。
  - ルールシート: 行列エディタ (タッチ版) + `🎲 ランダム` `ゼロ` `コピー` `リンク` (共有リンクをコピー。`docs/rule-generation-spec.md`) + プリセットを**横スクロールのチップ**で (`select` はやめる)。ランダムは `params.ruleGenerator` (既定 lifelike) で作る。
  - 設定シート: 品質 (`粒子数` スライダ、`自動品質` スイッチ)、`描画` (`点 / 顕微鏡 / ガラス` のセグメント = dots / scope / glass)、`粒子の大きさ`、`軌跡`、`種類数`、`ランダムのルール` (`生物らしい / 一様` = `ruleGenerator`)、`粒子をリセット`・`設定を初期化` (保存した設定を消して再読み込み)。`?advanced` のときだけ詳細 (調整パネル) を追加。表示・粒子の大きさ・軌跡・種類数・ランダムの作り方 (`renderMode` `organicStyle` `particleRadius` `trails` `numTypes` `ruleGenerator`) は再読み込みしても残す (localStorage `particle-life:mobile-settings`。粒子数・rMax は自動品質と画面の比率で決まるので残さない)。
- **没入モード**: 操作が 4 秒無いとツールバーが薄くなって隠れ (画面の端のタップで戻る)、ステータス表示も消える。ダブルタップや誤タップで物理ポインタを起こさない (UI 上のタップは canvas に届かない)。
- **フィードバック**: 自動品質で粒子数を減らしたら小さなトースト (「軽くしました: 2000 粒子」)。WebGL2 非対応・context lost のメッセージも同じ体裁。
- **見た目**: ダーク背景に合わせ、半透明パネル (backdrop-filter はあれば使う) と 12px 角丸、フォントは system-ui、タップ領域は 44px 以上、コントラスト AA、`env(safe-area-inset-*)` を全方向で考慮。縦・横の両方で破綻しない (横は左右どちらかの端にシートを出してもよい)。
- **アクセシビリティ**: ボタンは `<button>` + `aria-label`、シートは `role="dialog"` + `aria-modal`、フォーカス移動、トグルは `aria-pressed`。
- **描画の切り替え**: `view.renderMode` に `'dots' | 'organic'` を入れる。`renderer.capabilities.organic` が偽なら `有機` を無効表示にして dots のまま。既定は能力があれば `organic`、なければ `dots`。organic の実装は別担当が並行して作っている (`src/mobile/organicGl.js` / `glRenderer.js` は**編集しない**。`view.organic` には `params` をそのまま渡す)。
- **sim の生成**: `createSim()` (`src/mobile/simClient.js`、別担当が並行して作る) を呼ぶ。それが無い間は `CpuSimulation` を直接使い、import は 1 か所にまとめる。

検証 (UI 担当): 390x844 / 844x390 / 360x640 / 768x1024 のスクリーンショットを撮り、シート開閉・ツールバー自動隠れ・ルール編集 (タップ / 長押し)・プリセット切替・設定変更が動き、コンソールエラー 0。見た目は自分で画像を見て崩れを直す。

## organic のスタイル (決定: scope が既定)

スマホ版の organic は **scope** を既定にする (`config.js` の既定が scope。`?style=glass` か保存した設定で glass)。設定シートの `ガラス` か `?style=glass` で glass を描く (cell は描けないので scope にする)。scope の仕様は `docs/organic-rendering-spec.md` の「scope」節 (`softLarge`、`thresholdScale = 1.6`、`fine = {splat 0.4, small 0.4, large 1}`、`paper`、`scopeStain` / `scopeVignette` / `scopeSpeck`) と `src/gpu/shaders/organic.wgsl.js` の scope 部分。

scope の種類の描き分け (`docs/scope-species-spec.md` フェーズ 1) は `organicGl.js` にも入れてある。field (rg = cosθ, sinθ の加算、b = 0) は rgba16f の負値を保つ (3 次 B スプラインの重みは非負なのでリンギングは出ない)。染色の透過率は `stainColor.js` の `buildStainTables` をパレットが変わったときだけ作り、`uTransmit[16]` と `uNumTypes` で composite へ渡す (GLSL の OKLab は削除)。式・定数は PC の `decodeSpecies` / `scopeStyle` と同じ。

scope の密度による染色 (`docs/scope-species-spec.md` フェーズ 2 の実装メモ) も入れてある。`SHAPE_OCC_FS` が small の b に `1 - exp(-max(v, 0) / 12)` を書き (`SOFT_DOWN_FS` は 0 のまま)、composite は `rho = s.b` で染色の指数に `min(0.6 + 1.4 rho, 1)` を掛け、濃くする分と核の帯は `luma(T)` の累乗で暗くする (色相を保つ)。旧核小体は廃止。式・定数は PC と同じ。
