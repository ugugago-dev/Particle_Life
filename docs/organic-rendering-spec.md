# 有機的な描画 仕様書 (未実装・後回し)

粒子を「点の集まり」ではなく「細胞・組織・粘菌のような生き物」に見せるための描画仕様。
シミュレーション側は変更しない (描画は既存バッファの読み取りのみ)。

## 前提: 使えるデータ (すべて GPU 上、CPU 読み戻しなし)

| バッファ | 内容 | 用途 |
|---|---|---|
| `posVelA` vec4f | (x, y, vx, vy) | 位置、速度 (伸び・向き・脈動) |
| `metaA` vec2u | (type, id) | 色 (組織の種類)、id ごとの乱数位相 |
| `densityA` f32 | 重み付き近傍数 Σ(1 - r/rMax)² (前ステップ) | 構造の「中身の詰まり具合」。核・膜の判定 |

`densityA` は圧縮制限 (`limitPressure`) のために追加されたもので、描画側でもそのまま使える。
目安: 孤立粒子 ≈ 0、背景 ≈ 5〜10、構造の内部 ≈ 15〜35 (restDensity = 20 のとき)。

## 目標とする見た目

1. **膜 (メタボール)**: 近くの粒子同士が溶け合い、輪郭が滑らかな 1 つの塊になる。
2. **内部の濃淡**: 密度の高い部分 (構造の芯) は濃く・暗く「核」っぽく、縁は半透明で明るい「膜」。
3. **リムライト**: 塊の縁に細い明るい線 (細胞膜)。
4. **種類ごとの色の混ざり**: 異なる type の境界は色が滑らかに混ざる (組織の境界)。
5. **わずかな動き**: 速度方向に少し伸びる、id ごとの位相でゆっくり脈打つ。
6. 背景は暗いまま (既存の BG `#010e1d`)。

## 方式: 2 パス スクリーン空間メタボール

### パス 1: スプラット (フィールド蓄積)

- 出力: `field` テクスチャ (`rgba16float`, 解像度 = キャンバスの 1/2、GUI で 1/1〜1/4)。
- 各粒子をインスタンス描画 (既存の particle パイプラインと同じ 6 頂点の四角形)。
  - 半径 `splatRadius` (ワールド単位、既定 = rMax × 0.6)。
  - 速度方向に `1 + stretch × |v| / maxSpeed` 倍伸ばした楕円にする (既定 stretch = 0.5)。
- フラグメント: カーネル `w = (1 - d²)³` (d は楕円内の正規化距離、d ≥ 1 で discard)。
- 加算ブレンド (`one`, `one`) で書く値:
  - `rgb = palette[type] × w`
  - `a = w`
- 密度で重みを調整: `w *= mix(1.0, coreBoost, smoothstep(restDensity × 0.5, restDensity × 1.5, density))`
  (詰まった部分ほどフィールドが濃くなる)。

### パス 2: 合成 (フルスクリーン三角形 → canvas)

`field` をバイリニアでサンプルし、`F = field.a`、`C = field.rgb / max(F, ε)` (加重平均色)。

- **塗り**: `fill = smoothstep(threshold - edge, threshold + edge, F)` (既定 threshold = 0.5, edge = 0.08)。
- **核**: `core = smoothstep(threshold × 2, threshold × 4, F)` → 色を `C × (1 - 0.5 × core)` で暗く、彩度を少し上げる。
- **法線とリム**: `∇F` を中心差分で求め、`n = normalize(vec3(-∇F × normalScale, 1))`。
  - リム: `rim = (1 - fill) × smoothstep(threshold × 0.6, threshold, F)` を明るい色 (`C` を白寄せ) で加算。
  - 簡易ライティング: 固定の光源方向 `L` で `diffuse = 0.6 + 0.4 × dot(n, L)`。
- **内部のテクスチャ (任意)**: 粒子の位置にもとづく細かいノイズは使わず、`F` の等高線を薄く描いて
  「細胞質の模様」にする: `0.05 × sin(F × 20)`。
- 最終色 = `mix(BG, C × diffuse, fill × opacity) + rim × rimColor`。

### 粒子そのもの (任意で重ねる)

- `showParticles` が true のとき、既存の点描画を `alpha = 0.3`、半径半分で上に重ねる
  (「中の小器官」に見える)。

### トレイルとの関係

- `trails` が true のときは、パス 2 の出力先を既存のトレイルテクスチャにする
  (フェード → 合成結果を重ねる)。残像が「粘液の跡」になる。

## GUI (Display フォルダに `Organic` サブフォルダ)

| パラメータ | 既定 | 範囲 |
|---|---|---|
| `renderMode` | `'organic'` | `'dots' / 'organic'` |
| `fieldScale` | 0.5 | 0.25 / 0.5 / 1 |
| `splatRadius` (× rMax) | 0.6 | 0.2〜1.5 |
| `threshold` | 0.5 | 0.05〜2 |
| `edge` | 0.08 | 0.01〜0.3 |
| `coreBoost` | 1.5 | 1〜4 |
| `stretch` | 0.5 | 0〜2 |
| `rimStrength` | 0.6 | 0〜2 |
| `showParticles` | false | |

## 実装メモ

- 新規ファイル: `src/gpu/shaders/organic.wgsl.js` (splat と composite の 2 シェーダ)。
- `renderer.js`
  - `field` テクスチャは `ensureTrailTexture` と同様に、キャンバスサイズ × `fieldScale` で遅延生成。
  - splat パイプラインは加算ブレンド、`rgba16float` ターゲット、`loadOp: 'clear'` (0)。
  - composite は `textureSample` 用に `linear` サンプラを 1 つ作る。
  - `densityA` をバインド (binding 4) に追加。`updateParticleGroup` のキーにも含める。
- 周期境界: 画面端をまたぐ粒子は、splat の四角形が画面外にはみ出すだけで反対側に出ない。
  端で途切れるのが気になる場合は、端から `splatRadius` 以内の粒子だけ追加インスタンス
  (最大 4 コピー) を描く。最初は対応しなくてよい。
- 色空間: 既存どおりガンマ空間のまま加算して問題ない (平均色を取るので)。
- `RenderParams` に項目を足すときは 16 バイト境界 (vec2f は 8 バイト) に注意する。

## 性能目標

- 30,000 粒子、1920×1080、fieldScale 0.5 で、描画 GPU 時間が既存の点描画の 2 倍以内。
- splat の四角形はフィールド解像度で数十 px 程度になるので、オーバードローが主なコスト。
  重い場合は `fieldScale` を下げる / `splatRadius` を下げる。

## 受け入れ基準

1. `renderMode = 'dots'` で現在と同一の見た目 (回帰なし)。
2. `organic` でクラスタが滑らかな輪郭の塊になり、孤立した粒子は小さな丸い粒に見える。
3. 密度の高い構造の芯が暗く、縁に明るいリムが出る。
4. 異なる type が接する部分で色が滑らかに混ざる。
5. ウィンドウリサイズ・DPR 変更・trails の ON/OFF で破綻しない。
6. WebGPU の validation エラーがコンソールに出ない。
