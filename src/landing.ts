/**
 * ブラウザで開いた人に見せる頁。
 *
 * ここは記事もREADMEもRapidAPIの出品も指している着地点なのに、開くと
 * 9,772バイトの生JSONが出ていた。人が見て製品だと分からないし、
 * 検索エンジンにとっても application/json は日本語の頁として扱いにくい。
 *
 * API クライアントは壊さない。Accept に text/html が入っているときだけ
 * 差し替える。curl の既定は Accept: * / * なので JSON のまま。
 */
export const wantsHtml = (accept: string | undefined): boolean =>
  (accept ?? '').includes('text/html');

const BASE = 'https://japan-payroll-api.tsumugi.workers.dev';

export const landingPage = (): string => `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>日本の給与計算・社会保険のAPIとMCPサーバー | jp-payroll</title>
<meta name="description" content="日本の給与計算・社会保険・労務を計算して返すHTTP APIとMCPサーバー。47都道府県の保険料率、源泉所得税、標準報酬月額の決定と改定、割増賃金、年次有給休暇、最低賃金。答えには根拠の条文が付きます。無料枠あり、APIキー不要。">
<link rel="canonical" href="${BASE}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="日本の給与計算・社会保険のAPIとMCPサーバー">
<meta property="og:description" content="47都道府県の保険料率、源泉所得税、標準報酬月額、最低賃金を計算します。答えには根拠の条文が付きます。">
<meta property="og:url" content="${BASE}/">
<style>
:root{color-scheme:light dark;--fg:#16181d;--bg:#fff;--mute:#5b6270;--line:#e3e6ec;--acc:#0b5cd5;--code:#f6f7f9}
@media(prefers-color-scheme:dark){:root{--fg:#e8eaee;--bg:#14161a;--mute:#9aa2b1;--line:#2a2e36;--acc:#7aa9f7;--code:#1c1f25}}
*{box-sizing:border-box}
body{margin:0;padding:0 1.15rem 4rem;font:16px/1.85 system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:44rem;margin:0 auto}
h1{font-size:1.6rem;line-height:1.5;margin:2.4rem 0 .5rem;letter-spacing:.01em}
h2{font-size:1.17rem;margin:2.6rem 0 .7rem;padding-top:1.5rem;border-top:1px solid var(--line)}
h3{font-size:1rem;margin:1.6rem 0 .4rem}
p,li{color:var(--fg)}
.lede{font-size:1.06rem;color:var(--mute);margin:.2rem 0 1.4rem}
pre{background:var(--code);border:1px solid var(--line);border-radius:7px;padding:.8rem .95rem;overflow-x:auto;font-size:.845rem;line-height:1.7;margin:.6rem 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
p code,li code,td code{background:var(--code);border-radius:4px;padding:.1rem .34rem;font-size:.87em}
a{color:var(--acc)}
table{border-collapse:collapse;width:100%;margin:.7rem 0;font-size:.92rem}
th,td{border-bottom:1px solid var(--line);padding:.45rem .55rem;text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:600;white-space:nowrap}
.n{font-variant-numeric:tabular-nums;white-space:nowrap}
ul{padding-left:1.25rem}
li{margin:.3rem 0}
footer{margin-top:3rem;padding-top:1.3rem;border-top:1px solid var(--line);color:var(--mute);font-size:.89rem}
.tag{display:inline-block;font-size:.79rem;color:var(--mute);border:1px solid var(--line);border-radius:99px;padding:.05rem .6rem;margin:0 .3rem .35rem 0}
</style>
<main>

<h1>日本の給与計算・社会保険を、計算して返すAPIとMCPサーバー</h1>
<p class="lede">47都道府県の保険料率、源泉所得税、標準報酬月額の決定と改定、割増賃金、年次有給休暇、最低賃金、そして令和8年分の年末調整まで。<strong>答えには根拠の条文または通知が付きます。</strong></p>

<p><span class="tag">無料枠あり</span><span class="tag">APIキー不要</span><span class="tag">MCPツール 29本</span><span class="tag">エンドポイント 44本</span><span class="tag">OpenAPI 3.0</span></p>

<h2>使いかたは2通り</h2>

<h3>AIアシスタントから聞く(MCPサーバー)</h3>
<pre><code>claude mcp add jp-payroll -- npx -y jp-payroll-mcp</code></pre>
<p>「3月31日に辞めた人の3月分の社会保険料は?」と日本語で聞けば、計算して<strong>根拠の条文を添えて</strong>返します。</p>

<h3>ソフトウェアに組み込む(HTTP API)</h3>
<pre><code>curl "${BASE}/v1/payroll?prefecture=Tokyo&amp;monthly_salary=300000&amp;age=40"</code></pre>
<p>1回で健康保険・介護保険・厚生年金・子ども子育て拠出金・雇用保険・源泉所得税・手取り・事業主負担が返ります。<a href="/v1/payroll?prefecture=Tokyo&amp;monthly_salary=300000&amp;age=40">この呼び出しを今すぐ見る</a>。</p>

<h2>自前で書くと外れる場所</h2>

<h3>退職日が1日ちがうと、1か月分の保険料が動く</h3>
<p>資格喪失は<strong>退職日の翌日</strong>(健康保険法第36条)、保険料は<strong>喪失月には算定しない</strong>(同法第156条第3項)。3月30日退職なら3月分は<strong>かからず</strong>、3月31日退職なら<strong>かかります</strong>。東京都・40歳・月給30万円で、労使合計 <span class="n">95,130円</span>(従業員 <span class="n">46,500円</span>・事業主 <span class="n">48,630円</span>)の差です。</p>
<p><a href="/v1/eligibility?month=2026-03&amp;left_on=2026-03-31">判定を見る</a></p>

<h3>年齢は誕生日の前日に上がる</h3>
<p>4月1日生まれの人は3月31日に40歳になるので(年齢計算ニ関スル法律)、介護保険料は<strong>3月分から</strong>始まります。65歳・70歳・75歳の節目でも同じで、1日生まれの人だけ全部1か月早く動きます。</p>

<h3>「2等級差」は健康保険法に書いていない</h3>
<p>随時改定の基準は<strong>昭和36年 保発第4号</strong>という通達にあります。しかも上限・下限付近には、1等級差で改定が必要になる例外が4つあります。法律・政令・省令・通達の4層で決まるので、条文だけを追うと辿り着けません。</p>

<h3>最低賃金は「毎年10月」とは限らない</h3>
<p>発効日は都道府県ごとに違います。令和7年度の秋田県は <span class="n">1,031円</span>で、発効は <span class="n">2026-03-31</span>。「10月に一律」と実装すると半年近く違う額を使い続けます。</p>

<h2>答えには根拠が付きます</h2>
<p>健康保険法・厚生年金保険法・徴収法など<strong>8法令</strong>の条項を同梱しているので、その範囲は <code>?include=statute_text</code> で<strong>実際の文言</strong>まで取れます。実務の略称(健保法43条、厚年法81条の2、徴収法11条)も解決します。労働基準法や所得税法のように同梱していない法令は、<strong>推測した本文を返さずに断り、e-Gov の該当条文へ案内します。</strong></p>
<pre><code>curl "${BASE}/v1/statute?ref=健康保険法第43条"</code></pre>

<h2>数字の出どころ</h2>
<table>
<tr><th>データ</th><td>出典</td></tr>
<tr><th>社会保険料率・等級表</th><td>全国健康保険協会 保険料額表</td></tr>
<tr><th>源泉徴収税額表</th><td>国税庁 源泉徴収税額表</td></tr>
<tr><th>年末調整</th><td>国税庁 令和8年分 年末調整のしかた(給与所得控除後の給与等の金額の表 1,103行、速算表、各控除額の表、設例)</td></tr>
<tr><th>最低賃金</th><td>厚生労働省 地域別最低賃金</td></tr>
<tr><th>祝日</th><td>内閣府</td></tr>
<tr><th>改定の規則</th><td>e-Gov 法令検索、日本年金機構</td></tr>
</table>
<p>すべて公式資料から機械的に抽出し、<strong>そこに印刷されている値と突き合わせて</strong>います。協会けんぽの保険料額表と250通り(5都道府県×50等級)、国税庁の月額表の公表2,079セル全部を照合し、変更のたびに <span class="n">4,661件</span> の検証を実行します。</p>
<p><a href="/v1/data-freshness">各データの収録範囲と次の改定時期</a>を返すので、古くなったことが黙って進行しません。収録範囲の外の日付は、古い数字を返さずに断ります。</p>

<h2>料金</h2>
<p>この URL は<strong>無料</strong>です。APIキーもアカウントも要りません。上限は1分あたり300回の目安(超えると 429)と、一括処理の人数(無料は1回10人まで)の2つです。対話的な利用でどちらかに当たることはまずありません。500人を1回で処理する必要が出たら <a href="https://rapidapi.com/kishidadevil/api/japan-payroll-and-labor-constants">RapidAPI の有料プラン</a>へ。</p>

<h2>正直に書いておくこと</h2>
<ul>
<li><strong>届出の要否を判定するものであって、届出ではありません。</strong>保険者算定は日本年金機構の判断で異なることがあります。</li>
<li><strong>住民税は算出しません。</strong>前年所得と市区町村で決まり、事業主が計算するものではありません。</li>
<li><strong>国民健康保険の額も返しません。</strong>市町村の条例で決まるため、全国一律の額が存在しません。</li>
<li><strong>年末調整は令和8年分の計算を返しますが、医療費控除・寄附金控除・雑損控除は年末調整の対象外(確定申告)です。</strong>申告書に書かれた内容をそのまま渡してください。配偶者や扶養親族を推定しません。</li>
<li><strong>二以上の事業所に勤める人の按分は対象外です。</strong>保険料は各事業所の報酬で按分しますが、そのための他社の報酬額を受け取る口がありません。1事業所ぶんとして計算します。</li>
<li><strong>政府機関の承認・関与・保証を受けたものではありません。</strong>法定の届出に用いる前に、出典と照合してください。</li>
</ul>

<footer>
<p><a href="https://github.com/kishida-devil/jp-payroll-mcp">GitHub</a> ・ <a href="https://www.npmjs.com/package/jp-payroll-mcp">npm</a> ・ <a href="https://zenn.dev/kishida_devil/articles/9d5a645a105c0b">解説記事</a> ・ <a href="/openapi.json">OpenAPI 仕様書</a> ・ <a href="/v1/data-freshness">データの鮮度</a></p>
<p>このURLに <code>Accept: application/json</code> で来ると、エンドポイント一覧のJSONを返します。間違いを見つけたら GitHub に issue をください。</p>
</footer>

</main>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebAPI","name":"日本の給与計算・社会保険 API","description":"日本の給与計算・社会保険・労務を計算して返すHTTP APIとMCPサーバー。47都道府県の保険料率、源泉所得税、標準報酬月額、最低賃金。答えには根拠の条文が付きます。","inLanguage":"ja","url":"${BASE}/","documentation":"${BASE}/openapi.json","provider":{"@type":"Person","name":"岸田でびる"},"isAccessibleForFree":true}
</script>
`;
