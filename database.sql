CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('multishot', 'edit', 'price_update', 'split_excel')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  photo_limit INTEGER NOT NULL DEFAULT 16,
  expires_at TIMESTAMPTZ
);

CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  sell_prices JSONB DEFAULT '[]'::JSONB,
  buy_prices JSONB DEFAULT '[]'::JSONB,
  avg_sell INTEGER DEFAULT 0,
  avg_buy INTEGER DEFAULT 0,
  market_url TEXT,
  source TEXT NOT NULL CHECK (source IN ('screenshot', 'excel')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_telegram_id ON sessions(telegram_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_inventory_items_session_id ON inventory_items(session_id);

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

"-- Отключаем триггеры для ускорения
SET session_replication_role = 'replica';

-- Очищаем данные во всех таблицах (порядок важен из-за foreign keys)
TRUNCATE TABLE inventory_items CASCADE;
TRUNCATE TABLE sessions CASCADE;
TRUNCATE TABLE users CASCADE;

-- Включаем триггеры обратно
SET session_replication_role = 'origin';

-- Удаляем таблицы в правильном порядке зависимостей
DROP TABLE IF EXISTS inventory_items CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Удаляем расширение если нужно
DROP EXTENSION IF EXISTS ""pgcrypto"";"