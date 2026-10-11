# scope 描画の改善 仕様書 (種類の描き分け / 密度の色 / 異種の粒子の独立)

対象: `organicStyle: 'scope'` (PC = `src/gpu/shaders/organic.wgsl.js` + `src/gpu/renderer.js`、スマホ = `src/mobile/organicGl.js`)。
前提の仕組みは `docs/organic-rendering-spec.md`。glass / cell / dots の見た目は**変えない** (回帰なし)。シミュレーションも変えない。

## 動機 (現状の問題)

1. 種類の違う 2 粒子が「ぼかして混ざった」色で描かれる。dots では描き分けられているのに scope では無い。
   原因: splat が `色 x w` を種類をまたいで足し (`organic.wgsl.js` の splat `fs`)、小器官の色が `meanColor(s)`、細胞質の色が `meanColor(l)` = 線形平均なので、境界に第三の色相が出る。
2. 細胞に別の色の粒子が近づくと、外側に粒子が写り込み、細胞の輪郭も歪む。
   原因: 体の輪郭 (`n` の等高線) と小器官のゲート (`n >= 0.2 * scopeSpeck`) が種類を区別しない密度から作られ、異種の質量も壁を押し出し、ハローの内側なら何でも描かれる。細胞質の色も異種の色が混ざる。
3. 密度で色が変わらない。染色の濃さは占有度 `m` (しきい値 + ~1.5 で飽和) で決まり、生の密度が composite に届かない。

## 方針 (決定事項)

- ① 種類の復元 (案 A): scope の field には色の代わりに**種類を円周上の角度で表した 2 成分**を入れ、ブラー後に角度から種類を復元して**パレットの正確な色**で塗る。追加パス・追加テクスチャなし。
- ③ 密度: 空いたチャンネル (b) に**圧縮した生密度**を入れ、染色の深さと核の帯に使う。色相は動かさない。
- ② 異種の粒子 (i): 近づいた別種類の粒子は、壁の外の**独立した小さな点**として見せる。壁を押し出さず、細胞質に色を混ぜない。
- 実装順: ① -> ③ -> ② (①で空くチャンネルを③が使い、②は①のあとに見直す)。各フェーズは単独で動く状態でコミットする。

## 共通: scope の field の中身 (①で変わる)

scope のときだけ、field / shaped / small / large のチャンネルの意味を次のようにする (glass / cell は従来の rgb = 色のまま)。

| 場所 | r | g | b | a |
|---|---|---|---|---|
| field (splat 出力) | `w cosθ_t` | `w sinθ_t` | 0 | `w` |
| shaped (small 用、shape 出力) | `c cosθ̄` | `c sinθ̄` | `d` (圧縮密度、③。`c` を掛けない) | `c` |
| shaped large (soft、shape 出力) | `c_soft cosθ̄` | `c_soft sinθ̄` | 0 | `c_soft` |

- `θ_t = 2π (t + 0.5) / N`、`t` = 粒子の種類 (min(t, 15))、`N` = `palette.numTypes` (1〜16)。`N` は OrganicParams の新フィールド `numTypes` (f32 でよい) で渡す。
- 平均の埋め込み `e = rg / max(a, EPS)` (shape では `f.rg / max(f.a, EPS)`)。純粋な 1 種類なら `|e| = 1`、隣り合う 2 種の中点で `cos(π/N)`、離れた 2 種の中点では小さくなる。`purity R = |e|`。
- 復元: `u = atan2(e.y, e.x) / (2π/N) - 0.5` (連続な種類座標、種類 t で整数)、種類 `s = round(u)` (mod N)。
- 負の値が入るので、field / shaped / ブラー用テクスチャは符号つきの浮動小数 (rgba16float のまま)。mobile の RGBA16F も同じ。bspline など補間は負値でも線形なので問題ない。念のため mobile で負値がクランプされないことを確認すること。
- 角度の境界の AA は `fwidth(u)` を使わない (atan2 の折り返しで跳ぶ)。`gw = (length(dFdx(e)) + length(dFdy(e))) / max(|e|, 0.1) / (2π/N)` を u 単位の 1 px 幅とする。

### 種類ごとの染色色は CPU で作る

- 現在 composite の画素ごとに呼んでいる `stainColor` / `stainTransmit` (OKLab 変換) は、**パレットが変わったときだけ JS で計算**して uniform の配列に入れる (`stain[16]` = 密度 1 の染色の色、`transmit[16]` = `min(stain / SCOPE_BG, 1)`)。WGSL / GLSL の `stainColor` と OKLab 関数は削除する (どこからも呼ばれなくなる)。
- JS 版は `src/palette.js` か新規 `src/stainColor.js` に置く。現行 WGSL と同じ式・定数 (`STAIN_DL` 0.15、`STAIN_CHROMA` 1.2、`STAIN_CMAX` 0.19、黄の下げ幅 smoothstep(0.74, 0.9)、範囲外は線形 RGB で同じ L の灰色へ寄せる、最後に clamp(0.03, 1)) を使う。node のテストで「全 N (1〜16) で結果が 0.03〜1 に収まる」「パレットの色相 (OKLab の a, b の向き) が保たれる」「N = 3 / 6 / 10 の種類間の最小 ΔE x100 が仕様書の値 (29 / 14 / 5) に近い」を確認する。
- `SCOPE_BG` は WGSL の値 `(0.93, 0.94, 0.88)` と JS で共有する (定数を 1 か所にして、WGSL へは文字列で埋め込むか uniform で渡す)。

## フェーズ 1: ① 種類の描き分け

1. splat の頂点シェーダ: scope のときは `out.color = vec3f(cosθ_t, sinθ_t, 0)` (PC は `O.style == STYLE_SCOPE`、mobile は uniform の分岐かスタイル別のプログラム)。
2. shape (small 用 `shapeField` の occupancy、soft 用 `softField`): scope のときは上の表のとおり、`meanColor(f)` の代わりに `f.rg / max(f.a, EPS)` を使い `(e * c, 0 (③まで), c)` を出す。glass / cell は従来どおり。
3. composite (`scopeStyle`) の色の使い方:
   - 小器官: `e_s = s.rg / max(s.a, EPS)`、`u_s`、`s_s = round(u_s)`。色は `stain[s_s]` / `transmit[s_s]`。種類の境界は `weight = saturate((0.5 - |u_s - s_s|) / max(gw, 1e-4) + 0.5)` ではなく、**隣の種類との切り替え**として AA する: `u_s` の小数部 `f = u_s - floor(u_s)` に対し `mix(transmit[floor(u_s)], transmit[floor(u_s)+1], saturate((f - 0.5) / gw + 0.5))` (mod N)。N = 1 のときは常に `transmit[0]`。
   - 混合域: purity `R = |e_s|` が低い所 (離れた種類の混合・ほぼ同量の混合) は、染色の彩度を `R` に応じて落とす: `chromaKeep = smoothstep(0.35, 0.75, R)`、染色色を同じ輝度の灰色へ `(1 - chromaKeep)` だけ寄せる (定数 `SCOPE_PURITY_LO/HI`)。第三の種類が偽って現れるのを避けるための安全弁。
   - 区切り線: 小器官の内側で、種類が切り替わる位置 (`|f - 0.5|` が小さい所、幅 ~`0.8 dpr` px、`gw` で換算) に細い暗線を引く (色 = 両側の `outline` 色の平均を暗くしたもの、不透明度 ~0.5)。接する小器官が別の物に読めること (dots の描き分け)。
   - 細胞質 (体): `e_l = l.rg / max(l.a, EPS)` から同様に復元し、`transmit` は**隣の種類との線形補間** (切り替えの幅を u 単位 0.5 にしたソフトな版。広い領域で硬い境界を出さない)。
4. 設定・GUI に新しい項目は足さない (既存の `scopeStain` / `scopeVignette` / `scopeSpeck` / `threshold` / `blurLarge` のまま)。
5. mobile (`organicGl.js`): `SPLAT_VS` / `SHAPE_OCC_FS` / `SOFT_DOWN_FS` / `SCOPE_FS` を同じ変更に。`uStain[]` / `uTransmit[]` を uniform 配列で渡す (16 本、パレット変更時だけ更新)。

実装メモ (フェーズ 1、PC 版。仕様からの変更点):

- 切り替えの AA は `(f - 0.5) / gw` ではなく、e 空間で境界の半直線までの符号付き距離 `side = dot(e, (-sin φ, cos φ))` (φ = `(floor(u) + 1) 2π/N`) を `|dpdx e| + |dpdy e|` で割った px 距離を使う。隣の種類同士では同じ値になり、N = 2 や対蹠の種類 (e が原点を通り f が 0.5 を通らない) でも AA と区切り線が効く。
- 安全弁の範囲は R の固定値 (0.35, 0.75) ではなく N で正規化した値 (上限付き。`organic-rendering-spec.md` の scope の節)。固定値だと N = 2 / 3 の正しい境界が弁にかかり、N = 10 / 16 では偽の種類を消せない。
- 小器官の安全弁は彩度を落とす (灰色へ寄せる) のではなく、不透明度 `cover` を `keep` 倍にする (隙間をぼかしが埋めた所を隙間として見せる)。灰色の版は光沢のある白い楔に見えた。細胞質だけは明るい灰色へ寄せる。
- 細胞質の補間の幅は `saturate(side / sin(π/N) + 0.5)` (|e| = 1 で u の幅 0.5 にほぼ等しい)。
- `stain[]` は uniform に入れているが composite は `transmit[]` だけ読む。
- mobile (`organicGl.js`) も同じ式・定数で移植済み (`uTransmit[16]` + `uNumTypes`。`stain[]` は渡さない)。field が負値を持つが RGBA16F・線形補間・3 次 B スプライン (重みが非負) で問題なし。

受け入れ (フェーズ 1):

- 2 種類の粒子の塊が接する所で、境界に第三の色相が出ない (パレットの色だけ)。
- N = 1, 2, 3, 6, 10, 16 で破綻しない (N = 1 は従来どおり単色)。
- glass / cell / dots の出力が変更前とピクセル単位で同じ (固定 seed のスクリーンショットを比較)。
- WebGPU の validation エラーなし。`OrganicParams` のフィールド追加は `ORGANIC_FIELDS` と WGSL の struct を一致させる (`assertOrganicLayout`)。

## フェーズ 2: ③ 密度で色を変える

1. shape (small 用): `b = d`、`d = 1 - exp(-(v / SCOPE_DENS_S)^SCOPE_DENS_P)`、`v = f.a * O.fieldGain`。初期値 `S = 12, P = 1` (実測表: 殻 v 2〜5 -> d 0.15〜0.34、大細胞 p90 v 10 -> 0.56、300 粒以上の塊 v 27〜42 -> 0.89〜0.97)。`c` は掛けない (輪郭 `m` とは独立)。ブラーはそのまま線形に平均する。mobile の `SHAPE_OCC_FS` も同じ。
2. composite: `ρ = s.b` (small ぼかし後の圧縮密度)。
   - 染色の深さ: 現在の指数 `k * m * thick * grain` を `k * m * thick * grain * (SCOPE_DENS_BASE + SCOPE_DENS_GAIN * ρ)` に (初期値 BASE 0.6、GAIN 1.4)。薄い縁は淡く、濃い芯は深い。色相は `pow(T, 指数)` なので保たれる (色そのものを累乗しない)。
   - 核の帯: 現在の「`n >= 0.85` で最大 20% 暗く」(核小体) は廃止し、`ρ` で置き換える: 芯 (`smoothstep(0.6, 0.95, ρ)`) で最大 ~30% 暗く、わずかに染色の彩度を上げる (**色相は変えない**: 暗くするのは `pow(T, 追加の指数)` で)。細胞の核のように中心が濃く見えること。
   - 輪郭の線の色 (`outline`) は ρ が高いほど濃く。
3. 定数 (`SCOPE_DENS_S/P/BASE/GAIN`) は WGSL / GLSL で同じ値。見た目で調整してよいが、**色相を変えない**ことと、薄い縁が従来より濃くならないこと (ρ 小で BASE が効く) を守る。

受け入れ (フェーズ 2): 大きな細胞の芯が縁より明確に濃く、核のように見える。縁・小さな塊の見た目は従来から大きく変わらない。種類の色相は芯でも保たれる (橙が赤に寄らない)。

## フェーズ 3: ② 異種の粒子を独立した点として見せる

目標: 純粋に近い細胞 (A) の近くに別種類 (B) の粒子・小さな塊があるとき、(1) B が A の壁を押し出さない、(2) B が A の細胞質に色を混ぜない、(3) B が壁の外にあっても、ある程度の塊なら**自分の輪郭を持つ独立した点**として描かれる。
複数の種類でできた 1 つの生物 (核が A、殻が B など) を壁で割らないこと。「多数派だけを体とみなす」方式は使わない。基準は「周りの同種の質量」。

1. 前フレームの large ぼかしを shape の入力に束縛する (現在のフレームでは shape のあとに書かれるので、読み書きの衝突はない。最初のフレームは 0 で、減衰が無効になるだけ)。
2. shape の soft (large 用) 整形で、テクセルの種類座標 `u_p` (自分の `f.rg / f.a` から) と、同じ位置の前フレームの large `l_prev` から `D = round(u_D)`、`R_l = |e_D|`:
   - `foreign = smoothstep(0.55, 0.85, R_l) * saturate(circDist(u_p, u_D))` (`circDist` = N を周期とする種類座標の距離。同種で 0、1 以上離れると 1)。
   - `c_soft *= 1 - scopeIsolation * foreign` (新しい設定 `scopeIsolation` 0〜1、既定 0.85、0 で従来)。純粋に近い (R_l が高い) 細胞の中・周りの異種だけが減衰する。混合した生物 (R_l が低い) は減衰しない。
3. 小器官のゲート: 通常は従来どおり `n >= 0.2 * scopeSpeck` (ごみの抑制)。**異種の塊** (小器官の種類 `s_s != D` かつ `R_l` が高い) のゲートだけは、`n` ではなく**密度** `ρ >= SCOPE_FOREIGN_RHO` (初期値 0.35 = 7 粒以上の塊) に置き換える (壁の外でも、ある程度の塊なら描かれる。1〜数粒の異種は従来どおり描かれない)。
4. 壁の外の異種の塊には、自分の輪郭 (小器官の `outline`) が付く。壁は付かない (soft 整形が減衰しているため)。
5. 細胞質の色 (体の染色) は、フェーズ 1 のとおり `l` から復元する。②で `l` が異種を除いているため、異種の色は混ざらない。
6. GUI: `scopeIsolation` を `organicStyles.js` の scope の `params` に追加、`config.js` の既定 0.85、`gui.js` に項目、`renderer.js` の `COPIED_PARAMS` / `ORGANIC_FIELDS` に追加。mobile の設定シートにも出すかは後で決める (まずは既定値を `org` に渡すだけ)。
7. この減衰はヒューリスティック。効果が足りないときの次の手 (今回は実装しない): 種類グループごとの large 場。

受け入れ (フェーズ 3):

- 固定 seed で、純粋な細胞に別種の小さな塊が近づく場面の前後を比べ、壁の輪郭の歪みが減り、塊が壁の外の独立した点として見える。
- `scopeIsolation = 0` で従来に戻る (回帰確認)。
- 多種類の 1 生物が壁で割れない。

## 検証 (全フェーズ共通)

- ヘッドレス Chromium (Playwright、`/opt/pw-browsers/chromium`) で `index.html` を開き、固定 seed・固定ルール・固定ステップ数でスクリーンショットを撮って**目で確認**する。WebGPU が使えない環境なら、`--enable-unsafe-webgpu --use-angle=swiftshader` などで試す。それでも描けないなら、その旨を報告し、shape / composite の数式を node で再現して画像を出す。
- 比較用に変更前のスクリーンショット (git の元の版) も撮る。scope / glass / cell / dots の 4 つ。
- mobile 版は WebGL2 (swiftshader) で同様に確認する。
- 完了時に `docs/organic-rendering-spec.md` へ反映する (scope の節、`params` 表、パラメータ表、OrganicParams のフィールド数、テクスチャのチャンネルの意味)。
