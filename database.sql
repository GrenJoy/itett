-- Создаем таблицу пользователей
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Создаем таблицу сессий
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('oneshot', 'multishot', 'edit', 'price_update', 'split_excel')),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Создаем таблицу предметов инвентаря
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    sell_prices JSONB DEFAULT '[]'::jsonb,
    buy_prices JSONB DEFAULT '[]'::jsonb,
    avg_sell INTEGER DEFAULT 0,
    avg_buy INTEGER DEFAULT 0,
    market_url TEXT,
    source TEXT NOT NULL CHECK (source IN ('screenshot', 'excel')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Создаем индексы для ускорения запросов
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id ON sessions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_session_id ON inventory_items(session_id);

-- Конец скрипта

"SELECT * FROM sessions
ORDER BY created_at DESC;"

"SELECT
    s.id AS session_id,      -- ID сессии
    s.status AS session_status, -- Статус сессии (должен быть 'active')
    s.type AS session_type,     -- Тип сессии (multishot, edit и т.д.)
    i.name AS item_name,        -- Название предмета
    i.quantity,                 -- Количество
    i.sell_prices,              -- Цены продажи (в формате JSON)
    i.created_at AS item_added_at -- Когда предмет был добавлен
FROM
    sessions s
JOIN
    inventory_items i ON s.id = i.session_id
WHERE
    s.status = 'active'"