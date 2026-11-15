// Guild War Tracker - Cloudflare Worker (D1)
//
// POST /api/war/start   모드 → 전쟁 참여      (Authorization: Bearer API_KEY)
// POST /api/war/end     모드 → 승리/패배      (Authorization: Bearer API_KEY)
// GET  /api/summary     플레이어별 누적 집계
// GET  /api/wars        전쟁 기록 목록
// GET  /                조회 페이지

import { PAGE_HTML } from './page.js';

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
