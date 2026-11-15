export const PAGE_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>길드 전쟁 기록</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e8ee; --muted: #8a93a6;
    --accent: #e0b04a; --win: #3fb67a; --loss: #e05a5a; --left: #8a93a6; --ongoing: #4a90e0;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  h2 { font-size: 15px; margin: 28px 0 10px; color: var(--muted); font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 18px; padding: 12px;
             background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  input, select, button { font: inherit; color: var(--text); background: #0f1218; border: 1px solid var(--line);
                          border-radius: 7px; padding: 7px 10px; }
  input { min-width: 150px; }
  button { cursor: pointer; background: #222836; }
  button.primary { background: var(--accent); color: #1a1408; border-color: var(--accent); font-weight: 600; }
  button:disabled { opacity: .4; cursor: default; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .n { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .card .l { color: var(--muted); font-size: 12px; }
  .card.win .n { color: var(--win); } .card.loss .n { color: var(--loss); } .card.left .n { color: var(--left); }
  .table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; white-space: nowrap; }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; background: #141720; position: sticky; top: 0; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .link { color: var(--text); text-decoration: underline dotted var(--muted); cursor: pointer; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .b-win { background: rgba(63,182,122,.15); color: var(--win); }
  .b-loss { background: rgba(224,90,90,.15); color: var(--loss); }
  .b-left { background: rgba(138,147,166,.15); color: var(--left); }
  .b-ongoing { background: rgba(74,144,224,.15); color: var(--ongoing); }
  .rate { display: inline-block; width: 60px; height: 6px; background: var(--line); border-radius: 3px;
          vertical-align: middle; margin-left: 6px; overflow: hidden; }
  .rate i { display: block; height: 100%; background: var(--win); }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 10px; }
  .empty { padding: 28px; text-align: center; color: var(--muted); }
  .err { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: rgba(224,90,90,.12); color: var(--loss); display: none; }
  @media (max-width: 720px) { .cards { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>길드 전쟁 <span>기록</span></h1>
    <div class="muted" id="updated"></div>
  </header>

  <form class="filters" id="filters">
    <input name="player" placeholder="플레이어 이름">
    <input name="guild" placeholder="길드 이름 또는 접두어">
    <select name="result">
      <option value="">결과 전체</option>
      <option value="win">승리</option>
      <option value="loss">패배</option>
      <option value="left">이탈</option>
      <option value="ongoing">진행 중</option>
    </select>
    <select name="period">
      <option value="">전체 기간</option>
      <option value="today">오늘</option>
      <option value="7">최근 7일</option>
      <option value="30">최근 30일</option>
    </select>
    <button class="primary" type="submit">검색</button>
    <button type="button" id="reset">초기화</button>
  </form>

  <div class="err" id="err"></div>

  <div class="cards">
    <div class="card"><div class="n" id="c-total">-</div><div class="l">전쟁 참여</div></div>
    <div class="card win"><div class="n" id="c-win">-</div><div class="l">승리</div></div>
    <div class="card loss"><div class="n" id="c-loss">-</div><div class="l">패배</div></div>
    <div class="card left"><div class="n" id="c-left">-</div><div class="l">이탈</div></div>
  </div>

  <h2>플레이어별 누적</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th class="num">#</th><th>소속 길드</th><th>플레이어</th>
        <th class="num">참여</th><th class="num">승리</th><th class="num">패배</th><th class="num">이탈</th>
        <th>승률</th><th>마지막 참여</th>
      </tr></thead>
      <tbody id="summary"></tbody>
    </table>
  </div>

  <h2>전쟁 기록</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>소속 길드</th><th>플레이어</th><th>영토</th><th>전쟁 참여 시간</th><th>전쟁 종료 시간</th><th>결과</th>
      </tr></thead>
      <tbody id="wars"></tbody>
    </table>
  </div>
  <div class="pager">
    <span class="muted" id="pageinfo"></span>
    <button type="button" id="prev">이전</button>
    <button type="button" id="next">다음</button>
  </div>
</div>

<script>
(() => {
  const PAGE = 50;
  const fmt = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const RESULT = { win: ['승리', 'b-win'], loss: ['패배', 'b-loss'], left: ['이탈', 'b-left'], ongoing: ['진행 중', 'b-ongoing'] };
  const form = document.getElementById('filters');
  let offset = 0;

  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const time = (ms) => ms ? fmt.format(new Date(ms)) : '';

  function viewKey() { try { return localStorage.getItem('gwt_view_key') || ''; } catch { return ''; } }
  function setViewKey(k) { try { localStorage.setItem('gwt_view_key', k); } catch {} }

  function guildText(r) {
    if (r.guild_name == null) return '조회 중';
    if (r.guild_name === '') return '없음';
    return r.guild_prefix ? r.guild_name + ' [' + r.guild_prefix + ']' : r.guild_name;
  }

  function params() {
    const f = new FormData(form);
    const p = new URLSearchParams();
    for (const k of ['player', 'guild']) { const v = (f.get(k) || '').trim(); if (v) p.set(k, v); }
    const period = f.get('period');
    if (period === 'today') {
      const kst = new Date(Date.now() + 9 * 3600e3);
      p.set('from', String(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600e3));
    } else if (period) {
      p.set('from', String(Date.now() - Number(period) * 86400e3));
    }
    return p;
  }

  async function api(path, p) {
    const headers = {};
    const k = viewKey();
    if (k) headers['x-view-key'] = k;
    const res = await fetch(path + '?' + p.toString(), { headers });
    if (res.status === 401) {
      const key = prompt('조회 비밀번호를 입력하세요');
      if (key) { setViewKey(key); return api(path, p); }
      throw new Error('조회 비밀번호가 필요합니다.');
    }
    if (!res.ok) throw new Error('서버 오류 (' + res.status + ')');
    return res.json();
  }

  function setFilter(name, value) {
    form.elements[name].value = value;
    offset = 0;
    load();
  }

  function renderSummary(players) {
    const tb = $('summary');
    tb.replaceChildren();
    let t = 0, w = 0, l = 0, lf = 0;
    players.forEach((p, i) => {
      t += p.total; w += p.wins; l += p.losses; lf += p.lefts;
      const tr = el('tr');
      tr.append(el('td', String(i + 1), 'num'));
      tr.append(el('td', guildText(p)));
      const name = el('td'); const a = el('span', p.player_name, 'link');
      a.onclick = () => setFilter('player', p.player_name); name.append(a); tr.append(name);
      tr.append(el('td', String(p.total), 'num'));
      tr.append(el('td', String(p.wins), 'num'));
      tr.append(el('td', String(p.losses), 'num'));
      tr.append(el('td', String(p.lefts), 'num'));
      const decided = p.wins + p.losses;
      const rate = decided ? Math.round((p.wins / decided) * 100) : null;
      const rc = el('td', rate == null ? '-' : rate + '%');
      if (rate != null) { const bar = el('span', null, 'rate'); const fill = el('i'); fill.style.width = rate + '%'; bar.append(fill); rc.append(bar); }
      tr.append(rc);
      tr.append(el('td', time(p.last_started_at), 'muted'));
      tb.append(tr);
    });
    if (!players.length) { const tr = el('tr'); const td = el('td', '기록이 없습니다.', 'empty'); td.colSpan = 9; tr.append(td); tb.append(tr); }
    $('c-total').textContent = t; $('c-win').textContent = w; $('c-loss').textContent = l; $('c-left').textContent = lf;
  }

  function renderWars(data) {
    const tb = $('wars');
    tb.replaceChildren();
    for (const r of data.wars) {
      const tr = el('tr');
      tr.append(el('td', guildText(r)));
      const name = el('td'); const a = el('span', r.player_name, 'link');
      a.onclick = () => setFilter('player', r.player_name); name.append(a); tr.append(name);
      tr.append(el('td', r.territory || '-'));
      tr.append(el('td', time(r.started_at)));
      let endText;
      if (r.result === 'left') endText = '이탈';
      else if (r.result === 'ongoing') endText = '진행 중';
      else {
        const sec = Math.max(0, Math.round((r.ended_at - r.started_at) / 1000));
        endText = time(r.ended_at) + '  (' + Math.floor(sec / 60) + '분 ' + (sec % 60) + '초)';
      }
      tr.append(el('td', endText, r.result === 'left' || r.result === 'ongoing' ? 'muted' : ''));
      const [label, cls] = RESULT[r.result] || [r.result, ''];
      const rc = el('td'); rc.append(el('span', label, 'badge ' + cls)); tr.append(rc);
      tb.append(tr);
    }
    if (!data.wars.length) { const tr = el('tr'); const td = el('td', '기록이 없습니다.', 'empty'); td.colSpan = 6; tr.append(td); tb.append(tr); }
    const end = Math.min(data.offset + data.wars.length, data.total);
    $('pageinfo').textContent = data.total ? (data.offset + 1) + '–' + end + ' / ' + data.total + '건' : '';
    $('prev').disabled = data.offset <= 0;
    $('next').disabled = end >= data.total;
  }

  async function load() {
    const errBox = $('err');
    try {
      const p = params();
      const wp = new URLSearchParams(p);
      const result = form.elements.result.value;
      if (result) wp.set('result', result);
      wp.set('limit', String(PAGE)); wp.set('offset', String(offset));
      const [summary, wars] = await Promise.all([api('/api/summary', p), api('/api/wars', wp)]);
      renderSummary(summary.players);
      renderWars(wars);
      errBox.style.display = 'none';
      $('updated').textContent = '갱신 ' + time(Date.now());
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); offset = 0; load(); });
  $('reset').onclick = () => { form.reset(); offset = 0; load(); };
  $('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); };
  $('next').onclick = () => { offset += PAGE; load(); };
  setInterval(() => { if (!document.hidden) load(); }, 30000);
  load();
})();
</script>
</body>
</html>`;
