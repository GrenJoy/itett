# База данных Warframe Inventory Bot - Гайд по миграции

## Общая информация
Это руководство поможет вам создать базу данных для Telegram бота анализа инвентаря Warframe в Supabase или Neon PostgreSQL.

## Архитектура базы данных

### Таблицы
1. **users** - Пользователи Telegram
2. **sessions** - Сессии работы с ботом
3. **inventory_items** - Предметы инвентаря

### Связи
- users (1) → sessions (N) - один пользователь может иметь много сессий
- sessions (1) → inventory_items (N) - одна сессия содержит много предметов

## SQL для создания таблиц

```sql
-- Расширения PostgreSQL (если нужны)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Таблица пользователей
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id VARCHAR(50) UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индекс для быстрого поиска по telegram_id
CREATE INDEX idx_users_telegram_id ON users(telegram_id);

-- Таблица сессий
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('oneshot', 'multishot', 'edit', 'price_update', 'split_excel')),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы для сессий
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_telegram_id ON sessions(telegram_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_type ON sessions(type);

-- Таблица предметов инвентаря
CREATE TABLE inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name VARCHAR(500) NOT NULL,
    slug VARCHAR(255),
    quantity INTEGER NOT NULL DEFAULT 1,
    sell_prices JSONB DEFAULT '[]'::jsonb,
    buy_prices JSONB DEFAULT '[]'::jsonb,
    avg_sell DOUBLE PRECISION DEFAULT 0,
    avg_buy DOUBLE PRECISION DEFAULT 0,
    market_url VARCHAR(1000),
    source VARCHAR(20) NOT NULL DEFAULT 'screenshot' CHECK (source IN ('screenshot', 'excel')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы для предметов
CREATE INDEX idx_inventory_items_session_id ON inventory_items(session_id);
CREATE INDEX idx_inventory_items_name ON inventory_items(name);
CREATE INDEX idx_inventory_items_slug ON inventory_items(slug);
CREATE INDEX idx_inventory_items_source ON inventory_items(source);

-- Составной индекс для быстрого поиска дубликатов
CREATE INDEX idx_inventory_items_session_name ON inventory_items(session_id, name);
```

## Переменные окружения

Добавьте в ваш .env файл:

```env
# Database Connection
DATABASE_URL=postgresql://username:password@host:port/database_name

# Для Neon PostgreSQL (пример)
DATABASE_URL=postgresql://username:password@ep-xxx-xxx.region.neon.tech/neondb

# Для Supabase (пример)  
DATABASE_URL=postgresql://postgres.xxx:password@xxx.pooler.supabase.com:5432/postgres
```

## Настройка подключения

### Для Neon PostgreSQL:
1. Создайте проект в Neon
2. Скопируйте connection string из дашборда
3. Используйте pooled connection для production

### Для Supabase:
1. Создайте проект в Supabase
2. Перейдите в Settings → Database
3. Скопируйте Connection Pooling URI
4. Используйте Session mode для connection pooling

## Проверка целостности данных

После создания таблиц выполните:

```sql
-- Проверка структуры таблиц
\d users
\d sessions  
\d inventory_items

-- Проверка индексов
\di

-- Проверка связей
SELECT 
    tc.table_name, 
    kcu.column_name, 
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name 
FROM information_schema.table_constraints AS tc 
JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY';
```

## Типы данных

### Важные особенности:
- **UUID** - для всех ID (автогенерация)
- **JSONB** - для массивов цен (эффективнее JSON)
- **DOUBLE PRECISION** - для цен (поддержка десятичных)
- **TIMESTAMP WITH TIME ZONE** - для времени создания
- **CHECK constraints** - для валидации enum значений

### Размеры полей:
- `telegram_id`: VARCHAR(50) - достаточно для Telegram ID
- `name`: VARCHAR(500) - русские названия предметов могут быть длинными
- `slug`: VARCHAR(255) - английские slug'и с Warframe Market
- `market_url`: VARCHAR(1000) - URL'ы могут быть длинными

## Миграция существующих данных

Если у вас есть существующие данные:

```sql
-- Экспорт данных из старой БД
COPY users TO '/tmp/users.csv' WITH CSV HEADER;
COPY sessions TO '/tmp/sessions.csv' WITH CSV HEADER;  
COPY inventory_items TO '/tmp/inventory_items.csv' WITH CSV HEADER;

-- Импорт в новую БД
COPY users FROM '/tmp/users.csv' WITH CSV HEADER;
COPY sessions FROM '/tmp/sessions.csv' WITH CSV HEADER;
COPY inventory_items FROM '/tmp/inventory_items.csv' WITH CSV HEADER;
```

## Обслуживание БД

### Очистка старых данных:
```sql
-- Удаление завершенных сессий старше 30 дней
DELETE FROM sessions 
WHERE status IN ('completed', 'cancelled') 
AND created_at < NOW() - INTERVAL '30 days';

-- Удаление orphaned предметов (если есть)
DELETE FROM inventory_items 
WHERE session_id NOT IN (SELECT id FROM sessions);
```

### Анализ производительности:
```sql
-- Статистика по таблицам
SELECT schemaname, tablename, n_tup_ins, n_tup_upd, n_tup_del 
FROM pg_stat_user_tables;

-- Размер таблиц
SELECT 
    tablename,
    pg_size_pretty(pg_total_relation_size(tablename::regclass)) as size
FROM pg_tables 
WHERE schemaname = 'public';
```

## Безопасность

1. **Не используйте суперпользователя** для приложения
2. **Создайте отдельного пользователя** с минимальными правами:

```sql
-- Создание пользователя приложения
CREATE USER warframe_bot WITH PASSWORD 'strong_password';

-- Выдача необходимых прав
GRANT CONNECT ON DATABASE your_database TO warframe_bot;
GRANT USAGE ON SCHEMA public TO warframe_bot;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO warframe_bot;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO warframe_bot;
```

3. **Используйте SSL соединения**
4. **Ротируйте пароли** регулярно

## Мониторинг

Следите за:
- Размером таблиц
- Количеством активных соединений  
- Производительностью запросов
- Количеством orphaned записей

Это обеспечит стабильную работу бота с любым объемом данных.