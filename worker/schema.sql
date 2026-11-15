-- 길드 전쟁 기록
CREATE TABLE IF NOT EXISTS wars (
  id            TEXT PRIMARY KEY,          -- 모드가 만든 전쟁 ID (UUID)
  player_uuid   TEXT NOT NULL,
  player_name   TEXT NOT NULL,
  guild_name    TEXT,                      -- 전쟁 당시 소속 길드 (NULL = 아직 조회 전, '' = 길드 없음)
  guild_prefix  TEXT,
  territory     TEXT,
  started_at    INTEGER NOT NULL,          -- 참여 시간 (epoch ms)
  ended_at      INTEGER,                   -- 종료 시간 (승리/패배일 때만)
  result        TEXT CHECK (result IN ('win', 'loss', 'left')),  -- NULL = 진행 중
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wars_player_started ON wars (player_uuid, started_at);
CREATE INDEX IF NOT EXISTS idx_wars_started ON wars (started_at);
CREATE INDEX IF NOT EXISTS idx_wars_open ON wars (result, started_at);

-- 플레이어별 최근 이름/길드 캐시
CREATE TABLE IF NOT EXISTS players (
  uuid              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  guild_name        TEXT,
  guild_prefix      TEXT,
  guild_checked_at  INTEGER
);
