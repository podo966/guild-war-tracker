// Guild War Tracker - Cloudflare Worker (단일 파일 버전: 대시보드 편집기에 그대로 붙여넣기)
// 필요한 설정: D1 바인딩 이름 DB (선택: 비밀값 API_KEY, VIEW_KEY, WYNN_API_TOKEN), 크론 */10 * * * *

//
// POST /api/war/start   모드 → 전쟁 참여      (Authorization: Bearer API_KEY)
// POST /api/war/end     모드 → 승리/패배      (Authorization: Bearer API_KEY)
// GET  /api/summary     플레이어별 누적 집계
// GET  /api/wars        전쟁 기록 목록
// GET  /                조회 페이지


export const WAR_TIMEOUT_MS = 30 * 60 * 1000; // 참여 후 30분 안에 결과가 없으면 이탈
const GUILD_CACHE_MS = 6 * 60 * 60 * 1000;    // 길드 정보 재조회 주기
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;  // 7일보다 오래된 이벤트는 거부
const MAX_FUTURE_MS = 5 * 60 * 1000;          // 클라이언트 시계가 빠른 경우 보정

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal_error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(finalizeStale(env.DB, Date.now()));
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return new Response(PAGE_HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (pathname === '/api/war/start' || pathname === '/api/war/end') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    // API_KEY를 등록한 경우에만 키 검사 (등록 안 하면 누구나 기록 가능)
    if (env.API_KEY && !checkBearer(request, env.API_KEY)) return json({ error: 'unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    return pathname === '/api/war/start'
      ? handleStart(body, env, ctx)
      : handleEnd(body, env);
  }

  if (request.method === 'GET' && pathname.startsWith('/api/')) {
    if (env.VIEW_KEY && request.headers.get('x-view-key') !== env.VIEW_KEY
        && url.searchParams.get('key') !== env.VIEW_KEY) {
      return json({ error: 'view_key_required' }, 401);
    }
    await finalizeStale(env.DB, Date.now());
    if (pathname === '/api/summary') return handleSummary(url, env);
    if (pathname === '/api/wars') return handleWars(url, env);
  }

  return json({ error: 'not_found' }, 404);
}

// ---------------------------------------------------------------- 쓰기

async function handleStart(body, env, ctx) {
  const id = str(body.id, 64);
  const uuid = normUuid(body.uuid);
  const name = str(body.name, 16);
  const territory = str(body.territory, 64);
  const guildOverride = str(body.guild, 64);
  let startedAt = Number(body.startedAt);
  const now = Date.now();

  if (!id || !uuid || !name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    return json({ error: 'invalid_fields' }, 400);
  }
  if (!Number.isFinite(startedAt)) return json({ error: 'invalid_startedAt' }, 400);
  if (startedAt > now + MAX_FUTURE_MS) startedAt = now;
  if (startedAt < now - MAX_PAST_MS) return json({ error: 'too_old' }, 400);
  startedAt = Math.floor(startedAt);

  const db = env.DB;
  const cached = await db
    .prepare('SELECT guild_name, guild_prefix, guild_checked_at FROM players WHERE uuid = ?')
    .bind(uuid)
    .first();

  let guildName = null;
  let guildPrefix = null;
  let needLookup = false;
  if (guildOverride) {
    guildName = guildOverride;
  } else if (cached && cached.guild_checked_at && now - cached.guild_checked_at < GUILD_CACHE_MS) {
    guildName = cached.guild_name ?? '';
    guildPrefix = cached.guild_prefix ?? null;
  } else {
    needLookup = true;
  }

  const results = await db.batch([
    // 새 전쟁 참여 → 이 플레이어의 이전 진행 중 전쟁은 이탈
    db.prepare(
      `UPDATE wars SET result = 'left'
        WHERE player_uuid = ?1 AND result IS NULL AND id <> ?2 AND started_at <= ?3`
    ).bind(uuid, id, startedAt),
    db.prepare(
      `INSERT OR IGNORE INTO wars
         (id, player_uuid, player_name, guild_name, guild_prefix, territory, started_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(id, uuid, name, guildName, guildPrefix, territory || null, startedAt, now),
    // 재전송 등으로 순서가 늦게 도착했는데 이미 더 나중 전쟁이 있으면 이 전쟁은 이탈
    db.prepare(
      `UPDATE wars SET result = 'left'
        WHERE id = ?1 AND result IS NULL
          AND EXISTS (SELECT 1 FROM wars w2 WHERE w2.player_uuid = ?2 AND w2.started_at > ?3)`
    ).bind(id, uuid, startedAt),
    db.prepare(
      `INSERT INTO players (uuid, name) VALUES (?1, ?2)
       ON CONFLICT(uuid) DO UPDATE SET name = excluded.name`
    ).bind(uuid, name),
  ]);

  const inserted = results[1].meta?.changes ?? 0;
  if (needLookup) ctx.waitUntil(refreshGuild(env, uuid));

  return json({ ok: true, inserted: inserted > 0, previousMarkedLeft: results[0].meta?.changes ?? 0 });
}

async function handleEnd(body, env) {
  const id = str(body.id, 64);
  const uuid = normUuid(body.uuid);
  const result = body.result === 'win' || body.result === 'loss' ? body.result : null;
  let endedAt = Number(body.endedAt);
  const now = Date.now();

  if (!id || !uuid || !result || !Number.isFinite(endedAt)) {
    return json({ error: 'invalid_fields' }, 400);
  }
  if (endedAt > now + MAX_FUTURE_MS) endedAt = now;
  endedAt = Math.floor(endedAt);

  // 아직 진행 중이고 30분 이내에 끝난 경우에만 승/패 확정
  const res = await env.DB.prepare(
    `UPDATE wars SET result = ?1, ended_at = ?2
      WHERE id = ?3 AND player_uuid = ?4 AND result IS NULL
        AND ?2 >= started_at AND ?2 - started_at <= ?5`
  ).bind(result, endedAt, id, uuid, WAR_TIMEOUT_MS).run();

  return json({ ok: true, updated: (res.meta?.changes ?? 0) > 0 });
}

/** 결과 없이 30분 지난 전쟁을 이탈로 확정 */
export async function finalizeStale(db, now) {
  await db.prepare(
    `UPDATE wars SET result = 'left' WHERE result IS NULL AND started_at <= ?1`
  ).bind(now - WAR_TIMEOUT_MS).run();
}

/** Wynncraft API로 소속 길드 조회 후 캐시 및 길드 미기록 전쟁에 반영 */
export async function refreshGuild(env, uuid) {
  try {
    const dashed = toDashedUuid(uuid);
    const headers = { 'user-agent': 'GuildWarTracker/1.0 (Cloudflare Worker)' };
    if (env.WYNN_API_TOKEN) headers.authorization = `Bearer ${env.WYNN_API_TOKEN}`;
    const res = await fetch(`https://api.wynncraft.com/v3/player/${dashed}`, { headers });
    if (!res.ok) {
      console.warn('wynncraft api', res.status, uuid);
      return;
    }
    const data = await res.json();
    const guildName = data?.guild?.name ?? '';
    const guildPrefix = data?.guild?.prefix ?? null;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE players SET guild_name = ?2, guild_prefix = ?3, guild_checked_at = ?4 WHERE uuid = ?1`
      ).bind(uuid, guildName, guildPrefix, now),
      env.DB.prepare(
        `UPDATE wars SET guild_name = ?2, guild_prefix = ?3
          WHERE player_uuid = ?1 AND guild_name IS NULL`
      ).bind(uuid, guildName, guildPrefix),
    ]);
  } catch (err) {
    console.warn('guild lookup failed', uuid, String(err));
  }
}

// ---------------------------------------------------------------- 조회

const EFFECTIVE_RESULT = `COALESCE(result, 'ongoing')`;

function buildFilters(url) {
  const where = [];
  const args = [];
  const player = url.searchParams.get('player')?.trim();
  const guild = url.searchParams.get('guild')?.trim();
  const result = url.searchParams.get('result')?.trim();
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));

  if (player) { where.push(`player_name LIKE ? ESCAPE '\\'`); args.push(`%${escapeLike(player)}%`); }
  if (guild) {
    where.push(`(guild_name LIKE ? ESCAPE '\\' OR guild_prefix = ?)`);
    args.push(`%${escapeLike(guild)}%`, guild);
  }
  if (['win', 'loss', 'left', 'ongoing'].includes(result)) {
    where.push(`${EFFECTIVE_RESULT} = ?`); args.push(result);
  }
  if (Number.isFinite(from) && from > 0) { where.push('started_at >= ?'); args.push(from); }
  if (Number.isFinite(to) && to > 0) { where.push('started_at < ?'); args.push(to); }

  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

async function handleSummary(url, env) {
  const { sql, args } = buildFilters(url);
  const { results } = await env.DB.prepare(
    `SELECT player_uuid,
            (SELECT w2.player_name FROM wars w2 WHERE w2.player_uuid = wars.player_uuid
              ORDER BY w2.started_at DESC LIMIT 1) AS player_name,
            (SELECT w3.guild_name FROM wars w3 WHERE w3.player_uuid = wars.player_uuid
              ORDER BY w3.started_at DESC LIMIT 1) AS guild_name,
            (SELECT w4.guild_prefix FROM wars w4 WHERE w4.player_uuid = wars.player_uuid
              ORDER BY w4.started_at DESC LIMIT 1) AS guild_prefix,
            COUNT(*) AS total,
            SUM(result = 'win') AS wins,
            SUM(result = 'loss') AS losses,
            SUM(result = 'left') AS lefts,
            SUM(result IS NULL) AS ongoing,
            MAX(started_at) AS last_started_at
       FROM wars ${sql}
      GROUP BY player_uuid
      ORDER BY total DESC, wins DESC
      LIMIT 500`
  ).bind(...args).all();
  return json({ players: results ?? [] });
}

async function handleWars(url, env) {
  const { sql, args } = buildFilters(url);
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);

  const [rows, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, player_uuid, player_name, guild_name, guild_prefix, territory,
              started_at, ended_at, ${EFFECTIVE_RESULT} AS result
         FROM wars ${sql}
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM wars ${sql}`).bind(...args),
  ]);
  return json({ wars: rows.results ?? [], total: count.results?.[0]?.n ?? 0, limit, offset });
}

// ---------------------------------------------------------------- 유틸

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function checkBearer(request, key) {
  const h = request.headers.get('authorization') || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function normUuid(v) {
  if (typeof v !== 'string') return '';
  const hex = v.toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(hex) ? hex : '';
}

function toDashedUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- 조회 페이지 HTML
const PAGE_HTML = `<!DOCTYPE html>
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
