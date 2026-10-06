# 有機的な描画 仕様書

粒子を「点の集まり」ではなく「細胞・SmoothLife の構造」のように見せる描画 (`renderMode: 'organic'`)。
シミュレーション側は変更しない (描画は位置・種類の読み取りだけ)。`renderMode: 'dots'` は従来どおりの点描画で、変更なし。

参考にしたもの (すべて `docs/` 内):

- `st1.txt` (Shadertoy, 流体 + スライム) の Image パス (非ヘイトマップ側): `sin(vec3(1,2,3) * freq * r^3)`
- `st2.txt` (SmoothLife) の Image パス: 場そのもののグレースケール
- `st3.txt` (SmoothLife L) の Image パス: disk 平均 m と ring 平均 n による輪郭発光
- 水彩の生物細胞イラスト (青 -> ミント -> 淡黄の体、紫の核、顆粒)

## パイプライン (organic のとき、トレイルは無視して不透明な全画面を描く)

| # | パス | 入力 -> 出力 | 内容 |
|---|---|---|---|
| 0 | paper (cell だけ) | -> `paper` (rgba8unorm, canvas 解像度) | 画面固定のノイズ (紙の目・体の縁の揺らぎ・核の縁の揺らぎ) を焼く。canvas のサイズ / dpr が変わったとき (plan を作り直したとき) だけ |
| 1 | splat | 粒子 -> `field` (rgba16float、周囲に余白) (+ cell だけ `granule` (r16float、余白付き)) | 粒子ごとの四角形 (4 頂点の triangle-strip、instance = 粒子) を加算。`field` = (色 x w, w)。カーネルは等方の `(1 - d^2)^3`。周期境界のコピーは描かず、端をまたぐ分は余白 (スプラット半径 + 1 px) に落とす。cell は MRT のパイプライン (`fsGranule`)、ほかは field だけのパイプライン (`fs`) |
| 2 | shape | `field` -> `shaped` (L0) (+ cell だけ顆粒 -> 余白なしの `granule`) | 余白に落ちた端のはみ出しを反対側の端へ折り返して足し (周期境界)、スタイルに合わせて場を整形 (後述)。出力は `(平均色 x c, c)`。cell は顆粒も同じパスで折り返す (MRT、`fsGranule`) |
| 3 | downsample | L(k-1) -> L(k) | 2x2 の箱平均で 1/2 ずつ縮小。ブラーの σ が大きいときだけ (下記) |
| 4 | blur x 4 (bands は x 2) | L(ks) -> small、L(kl) -> large | 分離ガウス (水平 -> 垂直) を small (disk) と large (ring) の 2 本。サンプラは repeat (周期境界)。large を使わないスタイル (bands) は large のブラーと、その分の縮小段を作らない |
| 5 | composite | small + large + granule -> canvas | スタイルの着色。不透明。そのあとに粒子の重ね描き (`showParticles`) とポインタ円 |

解像度:

- `field` / `shaped` / `granule` は canvas x `fieldScale` (既定 0.5)。リサイズ・DPR 変更・スタイル変更 (large / 顆粒を使うかが変わるとき) は、field サイズと縮小段数・使うものの数値を毎フレーム前回の計画と比べて、変わったときだけテクスチャ・バインドグループを作り直す。顆粒テクスチャは cell だけ確保する。
- ブラーは 1 方向の σ を 5 テクセル以下に収める: σ (field の px) が大きいときは `ceil(log2(σ / 5))` 段だけ 1/2 に縮小した解像度で行う (最大 1/64)。small と large は別々に段数を決める。
- タップは「2 テクセルを 1 フェッチにまとめたバイリニア」の表 (CPU で計算して uniform に入れる。σ が変わったパスだけ書き直す)。半径 3σ (σ ≦ 5 テクセルなら 15 テクセル) で 1 方向 17 フェッチ、上限は 33 フェッチ。
- composite は small をバイリニアで canvas 解像度に引き伸ばしてサンプルし、large / granule は使うスタイルの分岐の中でだけサンプルする (使わないスタイルでは small が束縛されているだけ)。

## 正規化 (粒子数・画面サイズ・rMax に依存しない)

`field` は **画面全体の平均密度のとき 1**。粒子 1 個の重みは `w = 1 / (1.5 * ρ_mean * splatRadius^2)`。

- 密度 ρ = 重み付き近傍数 `Σ(1 - r/rMax)^2` の一様な場の粒子数密度は `n = 6ρ / (π rMax^2)`、カーネルの面積は `π s^2 / 4` (`s = splatRadius * rMax`)。よって `field = w * n * π s^2 / 4 = 1.5 * w * ρ * splatRadius^2`。
- 平均密度 `ρ_mean = N π rMax^2 / (6 A)` (A = 世界の面積 = アスペクト比 x 1)。
- 圧縮の制限が弱いと構造の芯は平均の 5〜30 倍になる (下の「実測した密度」)。なので `restDensity` は基準にしない。芯の高さは `fieldGain` と shape の飽和曲線で受ける。
- ブラー半径・スプラット半径は `rMax` の倍率 (ワールド単位) で持ち、field の px へは `fh / world.height` で換算するので、画面サイズ・DPR に依存しない。

## 実測した密度 (しきい値の根拠)

既定の設定 (60,000 粒子、rMax 0.03、restDensity 20、pressureStrength 0.005、16:9) で、ランダムなルール 4 通りを 1500 ステップ (15 秒) 回して測った
(field は 960x540 = fieldScale 0.5 の 1920x1080 相当。ρ_mean ≈ 15.9)。

- 粒子ごとの密度 ρ / ρ_mean は**二峰性**: ガスの山 ~0.35〜0.5 倍 (5〜8 個の小さな粒の塊。dots で散らばって見える点)、構造の山 4〜11 倍、谷は ~1〜1.4 倍。
  圧縮の制限は弱く (restDensity 20 ≈ 1.26 倍を超えても押し返しが小さい)、芯は 10〜30 倍まで詰まる。
- 粒子の位置での field の値 (ガスの粒子 = ρ < 1 倍、構造の粒子 = ρ > 1.5 倍):

| スプラット (x rMax) | 使うスタイル | ガス 中央値 / 90% / 99% | 構造 1% / 10% / 中央値 | 二つを分ける最適なしきい値 (誤分類) |
|---|---|---|---|---|
| 0.5 | cell / glow / mono | 0.6〜0.9 / 1.1〜1.5 / 1.6〜2.0 | 1.6〜2.3 / 2.9〜4.3 / 6.7〜12.6 | 1.8〜2.1 (0.4〜1.7%) |
| 0.3 | bands | 0.8〜1.4 / 1.5〜2.5 / 2.4〜3.6 | 1.6〜2.6 / 3.5〜5.1 / 8〜15 | 2.6〜3.3 (1.4〜5%) |
| 0.15 | glass | 1.7〜2.4 / 2.9〜4.3 / 4.5〜6.6 | 2.1〜3.3 / 4.5〜7.2 / 10〜19 | 4.1〜5.1 (2.4〜8.7%) |

- 画面の面積の 50〜70% は field < 0.3 (粒子の無い所)。ガスは一様な薄い場ではなく、小さな塊が点々と並んだもの。
  以前の `threshold 0.6` はガスの塊をほぼすべて通していた (glow / mono / cell が点だらけ、cell の核が肥大)。
- この測定から: `threshold` 1.5 (ガスの粒子の ~90% を落とし、構造の縁の細い膜 (粒の鎖の弧) は一部残す。2.0 だと膜も消える)、
  glass の `coreThreshold` 0.8 (圧縮後。field ~4.6 = 細かい場でのガスの 90〜99% 点)、bands の圧縮曲線 s = 6, p = 2.5、cell の `nucleusThreshold` 0.7。

## スタイル表 (`src/organicStyles.js`)

スタイルごとの違いは 1 つの表 `ORGANIC_STYLES` にまとめてあり、レンダラ・WGSL・GUI はここから導く。

| 項目 | 意味 |
|---|---|
| `index` | WGSL の `STYLE_<NAME>` (表から生成した定数。composite の `switch` の case) |
| `fine` | スプラット半径 / small ぼかし / large ぼかしの倍率 (bands: 0.6 / 0.5、glass: 0.3 / 0.3 / 1、ほかは 1) |
| `shape` | shape パスの種類 (`occupancy` / `compress` / `nucleus`)。WGSL の `SHAPE_<NAME>` |
| `granules` | 顆粒テクスチャを使う (cell だけ) |
| `params` | そのスタイルが読むスタイル固有の config 項目。GUI はこれに含まれる項目だけ表示する。`blurLarge` を含まないスタイルは large ぼかしを作らない |

## shape (ぼかす前の整形)

`v = field.a * fieldGain` (平均密度 = 1) として、スタイルの `shape` ごとに:

- occupancy (glow / mono / cell): `c = 1 - exp(-2 * max(v - threshold, 0))`。空き (ガス) は 0、構造の内部は ~1 の「占有度」。SmoothLife の場の値 (0 か 1 に近い) に当たる。これを small / large でぼかしたものが disk 平均 m、ring 平均 n。
- compress (bands): `c = 1 - exp(-(v / 6)^2.5)`。密度を 0..1 に圧縮 (ガスの塊 (v ≦ ~3.5) は c ≦ 0.2 で空きの青のレリーフ、構造の縁で立ち上がり、芯 (v > ~10) で飽和)。以前の `(v / 3.5)^1.8` はガスの塊を黄〜赤の点にしていた。ぼかす前に飽和させるので、芯の粒子ノイズが縞に乗らない。st1 の質量 r に当たる。
- nucleus (glass): 圧縮 `c0 = 1 - exp(-(v / 3.5)^1.8)` のあと `c = smoothstep(coreThreshold - 0.1, coreThreshold + 0.1, c0)`。「核 (密度が高い所) の指標」で、ガスも疎な粒の殻も 0。体・核・膜はすべてこの指標のぼかしから作る。

出力は `(field.rgb / field.a * c, c)`。ぼかし後の `rgb / a` が加重平均色 (種類の色)。

## スタイル (`organicStyle`)

以下 `m` = small ぼかし後の `a`、`n` = large ぼかし後の `a`、`C` = `rgb / a` (種類の平均色)。`tinted(base, C, k)` は明るさを保って色相を C へ `k` だけ寄せる。

### glow

st3 の式そのまま: `glow = max((1-n)^2 - (1-m)^2, 0) * 4 * glowIntensity`、色 `vec3(.6,.85,1.)` (種類の色を `speciesTint` だけ混ぜる)、
ベース `0.2 * m + vec3(0,.2,.2) * n`。密な構造の内側の縁と穴の縁が光り、一様な内部では打ち消し合う。

### glass (既定)

平らな 2D イラスト風の細胞 (3D 的なライティングはしない)。背景は青、体は一定の淡い水色の半透明、縁は白い線、核は種類の色の平らな塊。
**色の意味は核だけ** (体・膜には種類の色を混ぜない)。`m` / `n` = 核の指標 (shape) の small / large ぼかし、`Cs = s.rgb / s.a` = small ぼかしの加重平均色 (細かい)。
輪郭はすべて `fwidth` による約 1px のアンチエイリアスで、ぼかしの強さによらず「くっきりだが少し柔らかい」平面の形になる。

- 背景: 平らな青 `(.27,.57,.88)` -> `(.20,.47,.82)` のごくゆるい上下グラデーションだけ。
- 体: `n > 0.2` の半透明の円盤 (一定の `(.62,.82,.98)`、背景に 80% で重ねる)。核の指標から作るので、核を持たないガスのかたまり・疎な粒の殻は体にならず、輪も出ない。
- 膜: 体の輪郭の等高線 `n = 0.2` に沿った一定幅 (canvas px、半幅 `0.9 * rimStrength * dpr`) の白い線。勾配が弱い所 (平らな頂上・くびれ) では出さない。
- 核: `m > 0.5` の内側を `Cs` で平らに塗る。細かい場 (スプラット 0.3 倍 x 0.5 = 0.15 rMax、small ぼかし 0.3 倍) の色なので、粒が作る縞 (緑 / 赤) や色の混ざりがそのまま残る。
  縁に、自分の色を暗く (x 0.62) 少し濃くした約 1px (`1.2 * dpr`) の縁取りを付けて、淡い体から分離する。`n < 0.2` の小さな粒は核としても出さない。
- 画面固定のノイズ・スペキュラ・陰影・屈折・ビネット・外側の輪は使わない (動いても揺らがない)。
- glass も bands と同様に細かい場 (スプラット 0.3 倍、small ぼかし 0.3 倍)。large ぼかしは縮めない (体の輪郭に使うため)。

### bands

`col = max(sin(vec3(1,2,3) * bandFreq * r^3), 0)`、`r = bandBase + 0.8 * c` (c = shape で圧縮した密度をぼかしたもの)。

- 空き (c = 0) は `r = bandBase = 0.24` (st1 の `density_target`)。位相 `25 * 0.24^3 ≈ 0.35` なので `sin(0.35, 0.69, 1.04) ≈ (0.34, 0.64, 0.86)` = 明るい青。画面全体がこの青で、ガスの粒子ごとのわずかな密度差が水色〜淡い青のレリーフになる。
- 密度が上がると位相が進み、黄 -> 赤 -> 紫 -> 緑 -> 青 -> 黒 の周期を何回も通る (位相 ≈ 2π の倍数付近が黒い輪)。構造の縁は虹色の輪、芯は飽和した位相 (既定では紫) になる。
- bands だけ、スプラット半径を 0.6 倍、small ぼかしを 0.5 倍にして細かい場にする (st1 の密度のカーネルが ~2px と細かく、筋状のレリーフになるため)。large ぼかしは使わない。
- 控えめなエンボス: small ぼかしの密度を高さとみなし、勾配から固定光源 (左上) の陰影 `1 + 0.35 * (dot(n, L) - L.z)` を色に掛ける。
- `speciesTint` は半分の強さで種類の色相を混ぜる。

### mono

`smoothstep(0, 1, mix(m, n, 0.35))` のグレースケール (わずかに種類の色)。黒地に白い柔らかい構造、粒子の無い所は黒。

### cell

水彩の細胞イラスト。背景はオフホワイトの紙 (画面固定の value noise で目を付ける)。

- 画面固定のノイズ (紙の目 = `0.6 vnoise(px 0.8) + 0.4 vnoise(px 2.3)`、縁の揺らぎ = `fbm(px 0.045)`、核の揺らぎ = `fbm(px 0.11)`、px = CSS px) は
  paper パスで rgba8unorm のテクスチャに焼いておき、composite は 1 回の `textureLoad` で読む (毎フレーム画素ごとに最大 32 回のハッシュを計算しない。8 bit への量子化による差は画面で最大 1/255)。
- 体: `mb = mix(m, n, 0.4) + 低周波ノイズ`、`body = smoothstep(0.3, 0.62, mb)` (縁 = 占有度 0.5 付近の等高線、ノイズでやや不規則)。外側に薄い青のにじみ。
- 色: 深さ `depth = smoothstep(0.45, 0.98, mix(m, n, 0.6))` (縁 0 -> 内部 1) で 青 `(.36,.56,.86)` -> ミント `(.72,.91,.82)` -> 淡黄 `(.99,.96,.72)`。縁に少し濃い帯 (顔料だまり)、紙の目でムラ。
- 核: `nuc = smoothstep(nucleusThreshold ± 0.03, n + 粗いノイズ)`。縁が濃く中心がやや明るい紫。大きなぼかしがほぼ満杯の所 = 大きな塊の中心だけに出る。
- 顆粒: splat のときに粒子の約 3% (id のハッシュ) が、向きがランダムな小さな楕円 (長軸 0.42 s、短軸 = 長軸 / 1.7) を `granule` へ加算。composite で体の内側だけ薄く暗く描く。粒子といっしょに動く。

## パラメータ (`config.js` -> GUI の Display / Organic -> `renderer.js`)

| パラメータ | 既定 | 範囲 (GUI) | 意味 |
|---|---|---|---|
| `renderMode` | `'organic'` | `dots` / `organic` | |
| `organicStyle` | `'glass'` | `glass` / `cell` / `glow` / `bands` / `mono` | スタイル固有の項目 (`blurLarge` / `speciesTint` を含む) は、そのスタイルが読むときだけ GUI に出る |
| `fieldScale` | 0.5 | 0.25 / 0.5 / 1 | field の解像度 (canvas に対する比)。重い場合は下げる |
| `splatRadius` | 0.5 | 0.2〜1.5 | スプラット半径 (x rMax) |
| `fieldGain` | 1 | 0.2〜4 | 正規化した場への倍率 (全スタイル) |
| `blurSmall` | 0.15 | 0.05〜1.5 | small (disk) ぼかしの σ (x rMax) |
| `blurLarge` | 0.45 | 0.3〜4 | large (ring) ぼかしの σ (x rMax)。広いときは低解像度で計算。bands は使わない |
| `speciesTint` | 0.3 | 0〜1 | 種類の色をスタイルの色へ混ぜる量 (bands は半分の強さ、glass は使わない: 種類の色は核だけ) |
| `threshold` | 1.5 | 0.05〜4 | cell / glow / mono: 平均密度の何倍未満を「空き」とするか |
| `glowIntensity` | 1 | 0〜3 | glow: 輪郭の明るさ |
| `bandFreq` | 25 | 1〜100 | bands: 縞の周波数 (位相 = `bandFreq * r^3`) |
| `bandBase` | 0.24 | 0.05〜0.6 | bands: 空き (密度 0) の r。`bandFreq * bandBase^3 ≈ 0.35` で st1 と同じ明るい青 |
| `nucleusThreshold` | 0.7 | 0.3〜0.99 | cell: 核が始まる large ぼかしの占有度 |
| `coreThreshold` | 0.8 | 0.3〜0.99 | glass: 核 (種類の色の平らな塊) が始まる密度 (圧縮後、0..1。shape の指標のしきい値)。以前は `nucleusThreshold` と共用だったが、意味も最適値も違うので分けた |
| `rimStrength` | 1.3 | 0〜2 | glass: 膜の線の太さ・濃さ |
| `showParticles` | false | | 粒子 (半径半分、alpha 0.3) を上に重ねる |

以前の `edge` / `coreBoost` / `stretch` と、旧 `threshold` (メタボールのしきい値) は廃止。`threshold` は上記の意味に変わった。
しきい値の既定は「実測した密度」の節の測定から決めた。粒子数・rMax・圧縮の制限を大きく変えて密度の分布が変わったら、同じ手順で測り直す。

## 調整のコツ (目で見て決める所)

- 構造の大きさは rMax 基準 (実測: 1 つの塊の半径がおよそ 0.5〜1 rMax)。輪郭が太すぎる / 細すぎるときは `blurLarge` と `splatRadius` を同じ向きに動かす。glow は large の σ が塊の半径に近いと塊全体が光り、半径より小さいと縁だけ光る。
- cell の核は `blurLarge` が大きいほど出にくい (n が下がる)。`nucleusThreshold` を下げるか `blurLarge` を下げる。
- ガスが見えすぎる / 構造が痩せるときは `threshold` (1.2〜2.0 が実用範囲。2.0 でガスはほぼ消えるが細い膜も消える)。
- glass で小さな粒が白い縁の欠片として出るときは `coreThreshold` を上げる (0.85 以上では小さな本物の核も消え始める)。
- bands の縞が細かすぎる (ノイズに見える) ときは `bandFreq` を下げる。空きの青を変えたいときは `bandBase` (位相 `bandFreq * bandBase^3`: 0.35 = 水色、0.8 = 黄緑〜黄、1〜2 = 赤)。芯の色 (飽和したときの位相) は `bandFreq` で動く。

## パレット (`src/palette.js`)

種類の色は OKLCH で生成する (dots モードと行列エディタも同じパレット)。HSL の等間隔の色相 (赤・黄・緑・水色・青・マゼンタ) は、青が青い背景に溶け、水色が淡い体・白い縁と区別できず、明るさもばらばら (黄・水色は明るく青・マゼンタは暗い) だった。

- 明るさ L = 0.73、彩度 C = 0.16 を基本にそろえる。ただし黄は高い L でないと黄色に見えない (そろえると泥っぽいからし色になり、赤やピンクと平均したときも茶色くなる) ので、色相 96° を中心に raised-cosine の山 (半幅 60°) で L を最大 +0.16 (黄 ≈ 0.89)、C を +0.01 持ち上げる。橙は +0.06 ほど、赤・緑・紫・ピンクは基本の L のまま。sRGB に収まらない色は色相と L を保ったまま C を下げる。明るい体の上でも暗い dots の背景の上でも読める値。
- 色相は 295° (紫) -> マゼンタ -> 赤 -> 橙 -> 黄 -> 145° (緑) の弧に等間隔。背景の青 (OKLCH で L 0.57–0.65、C 0.14–0.15、h 251–256°) と体 (L 0.84、h 243°) の色相帯 (約 150°–290°) を避ける。6 種類なら 紫 / ピンク / 赤 / 橙 / 黄 / 緑。種類数はいくつでもよい (弧を等分する)。
- 7 種類以上では、隣り合う色の見分けのため L を交互に ±0.05 ずらす。
- `createPalette(n)` は従来どおり `{ numTypes, css, rgb }` を返す。css は `rgb(r g b)`。

## 実装メモ

- `src/organicStyles.js`: スタイル表 (上記)。
- `src/gpu/shaders/organic.wgsl.js`: `splatWGSL` / `shapeWGSL` / `downsampleWGSL` / `blurWGSL` / `compositeWGSL`。`paperWGSL` (cell の画面固定ノイズ)。`OrganicParams` は 17 個の 4 バイト値 (68 バイト。style / shape だけ u32。fieldW / fieldH / margin は splat と shape の余白付き field の座標用)。フィールド名は config.js の項目名と同じで、JS 側の `ORGANIC_FIELDS` と WGSL の struct の一致は起動時に `assertOrganicLayout` (common.wgsl.js の `assertStructLayout`) が確認する。`BlurParams` は 288 バイト。全画面三角形の頂点シェーダ `FULLSCREEN_VS` は render.wgsl.js のものを fade / blit / organic で共有する。
- `src/gpu/renderer.js`: `updateOrganicLayout` (field の解像度・σ・縮小段数)、`ensureOrganicPlan` / `buildOrganicPlan` (テクスチャ・パス・バインドグループ)、`drawOrganic`、`writeOrganicUniform` (変わったときだけアップロード)、`writeBlurUniforms`、`writeGaussianTaps`。
- `trails` は organic では無視 (dots に戻したときは従来どおり)。`densityA` は読まない (simulation.js の `needDensity` も無くした。density パスは圧縮の制限が有効なときだけ走る)。
- 性能の目安 (60,000 粒子、1920x1080、fieldScale 0.5、Intel UHD (内蔵 GPU)、描画 GPU 時間。下記の最適化の前の値): glass ≈ 4.3 ms、bands ≈ 4.7 ms、cell ≈ 11 ms (ノイズが重い)、glow / mono ≈ 7.3 ms。dots は 0.5 ms。
- 最適化 (同じ見た目のまま仕事を減らしたもの。swiftshader 上のタイムスタンプで計測、絶対値は実 GPU と違う):
  - splat の周期境界を「粒子 x 4 instance」から「余白付き field + shape での折り返し」に: 頂点シェーダの実行が 1 粒子 24 回 -> 4 回 (strip 込み)。splat の時間 1/3。
  - cell の画面固定ノイズを焼く: composite の画素ごとのハッシュ計算 (最大 32 回) が textureLoad 1 回に。
  - 四角形 (dots / splat / ポインタ円) を triangle-list の 6 頂点から triangle-strip の 4 頂点に。
- 周期境界: splat の余白の折り返しとブラーの repeat サンプラで、画面の端でも輪郭が途切れない。縮小 (downsample) だけは端をクランプする (奇数サイズのときの最後の 1 テクセルだけ影響)。
  余白は field の大きさで頭打ち (スプラット半径が field より大きい極端な設定では 1 回分しか折り返さない。以前の 4 コピー方式と同じ)。

## 受け入れ基準

1. `renderMode = 'dots'` で従来と同一の見た目 (回帰なし)。
2. 各スタイルが参考の見た目 (上記) の方向になる: glass = 青い平らな背景に白い縁の半透明の細胞と、種類の色の平らな核 (中の縞・混ざりも dots と同じに読める)、glow = 暗い内部と光る輪郭、bands = 画面全体が明るい青で、構造が虹色の輪になり芯は紫、mono = 黒地に白い構造、cell = 青->ミント->淡黄の体 + 紫の核 + 顆粒。
3. 粒子数・画面サイズ・rMax を変えても極端に暗く / 明るくならない (場は平均密度で正規化)。
4. ウィンドウリサイズ・DPR 変更・trails の ON/OFF・スタイル / 半径の変更で破綻しない。
5. WebGPU の validation エラーがコンソールに出ない。
