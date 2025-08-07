# База данных PostgreSQL - Руководство по настройке

## 🔧 Настройка DATABASE_URL

### 1. Установка переменной окружения
```bash
export DATABASE_URL="postgresql://username:password@hostname:port/database_name"
```

**Пример для Neon:**
```bash
export DATABASE_URL="postgresql://neondb_owner:your_password@ep-dawn-butterfly-a26gm10o-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require"
```

### 2. Проверка подключения
```bash
# В консоли Replit выполните:
echo $DATABASE_URL
```

## 📊 Создание таблиц и схемы

### Автоматическое создание через Drizzle
```bash
# Применить схему к базе данных
npm run db:push
```

### Ручное создание через SQL Editor
Если автоматическое создание не работает, выполните следующие SQL команды:

```sql
-- Создание таблицы пользователей
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Создание таблицы сессий
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR REFERENCES users(id) NOT NULL,
    telegram_id TEXT NOT NULL,
    type TEXT CHECK (type IN ('oneshot', 'multishot', 'edit', 'price_update', 'split_excel')) NOT NULL,
    status TEXT CHECK (status IN ('active', 'completed', 'cancelled')) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    completed_at TIMESTAMP
);

-- Создание таблицы предметов инвентаря
CREATE TABLE IF NOT EXISTS inventory_items (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR REFERENCES sessions(id) NOT NULL,
    name TEXT NOT NULL,
    slug TEXT, -- Может быть NULL для предметов не найденных в Warframe Market
    quantity INTEGER NOT NULL DEFAULT 1,
    sell_prices JSONB DEFAULT '[]'::jsonb, -- Массив цен продажи
    buy_prices JSONB DEFAULT '[]'::jsonb,  -- Массив цен покупки
    avg_sell INTEGER DEFAULT 0,  -- Средняя цена продажи в платине * 100
    avg_buy INTEGER DEFAULT 0,   -- Средняя цена покупки в платине * 100
    market_url TEXT,             -- Ссылка на Warframe Market
    source TEXT CHECK (source IN ('screenshot', 'excel')) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Создание индексов для производительности
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id ON sessions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_inventory_session_id ON inventory_items(session_id);
```

## 🔍 Проверка создания таблиц

```sql
-- Проверка существования таблиц
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('users', 'sessions', 'inventory_items');

-- Проверка структуры таблицы users
\d users

-- Проверка структуры таблицы sessions  
\d sessions

-- Проверка структуры таблицы inventory_items
\d inventory_items
```

## 📋 Тестирование функциональности

### 1. Создание тестового пользователя
```sql
INSERT INTO users (telegram_id, username, first_name, last_name) 
VALUES ('123456789', 'test_user', 'Test', 'User');
```

### 2. Создание тестовой сессии
```sql
INSERT INTO sessions (user_id, telegram_id, type, status) 
VALUES (
    (SELECT id FROM users WHERE telegram_id = '123456789'),
    '123456789',
    'oneshot',
    'active'
);
```

### 3. Проверка изоляции сессий
```sql
-- Все сессии пользователя
SELECT * FROM sessions WHERE telegram_id = '123456789';

-- Активные сессии
SELECT * FROM sessions WHERE status = 'active';

-- Предметы в сессии
SELECT * FROM inventory_items WHERE session_id = 'your_session_id';
```

## 🧹 Очистка данных

### Очистка всех данных (осторожно!)
```sql
-- Удаление всех предметов
DELETE FROM inventory_items;

-- Удаление всех сессий
DELETE FROM sessions;

-- Удаление всех пользователей
DELETE FROM users;
```

### Очистка данных конкретного пользователя
```sql
-- Удаление предметов пользователя
DELETE FROM inventory_items 
WHERE session_id IN (
    SELECT id FROM sessions WHERE telegram_id = '123456789'
);

-- Удаление сессий пользователя
DELETE FROM sessions WHERE telegram_id = '123456789';

-- Удаление пользователя
DELETE FROM users WHERE telegram_id = '123456789';
```

## 🚨 Возможные проблемы и решения

### 1. Ошибка подключения
```
Error: Connection refused
```
**Решение:** Проверьте правильность DATABASE_URL и доступность базы данных.

### 2. Ошибка прав доступа
```
Error: Permission denied
```
**Решение:** Убедитесь, что пользователь имеет права CREATE, INSERT, UPDATE, DELETE.

### 3. Ошибка уникальности
```
Error: duplicate key value violates unique constraint
```
**Решение:** Очистите таблицу users или измените telegram_id.

### 4. Ошибка типов данных
```
Error: column type mismatch
```
**Решение:** Используйте правильные типы данных (JSONB для массивов цен).

## 📈 Мониторинг производительности

```sql
-- Количество пользователей
SELECT COUNT(*) as total_users FROM users;

-- Количество активных сессий
SELECT COUNT(*) as active_sessions FROM sessions WHERE status = 'active';

-- Количество предметов в базе
SELECT COUNT(*) as total_items FROM inventory_items;

-- Статистика по типам сессий
SELECT type, COUNT(*) as count 
FROM sessions 
GROUP BY type;

-- Топ пользователей по количеству предметов
SELECT u.telegram_id, u.username, COUNT(ii.id) as items_count
FROM users u
JOIN sessions s ON u.id = s.user_id
JOIN inventory_items ii ON s.id = ii.session_id
GROUP BY u.id, u.telegram_id, u.username
ORDER BY items_count DESC
LIMIT 10;
```

## 🔐 Безопасность

1. **Никогда не передавайте DATABASE_URL в открытом виде**
2. **Используйте SSL подключения (sslmode=require)**
3. **Регулярно очищайте старые сессии**
4. **Ограничивайте права пользователя базы данных**

## 📝 Backup и восстановление

### Создание резервной копии
```bash
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Восстановление из резервной копии
```bash
psql $DATABASE_URL < backup_20250805_120000.sql
```