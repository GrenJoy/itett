-- Warframe Inventory Telegram Bot Database Setup
-- Run this SQL code in your Neon PostgreSQL console
-- Database URL: postgresql://neondb_owner:npg_kAwnpXuqj58E@ep-dawn-butterfly-a26gm10o-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table - stores Telegram user information
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Sessions table - tracks user sessions for different operation modes
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR NOT NULL REFERENCES users(id),
    telegram_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('oneshot', 'multishot', 'edit')),
    status TEXT DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    completed_at TIMESTAMP
);

-- Inventory items table - stores analyzed items from screenshots and Excel files
CREATE TABLE IF NOT EXISTS inventory_items (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR NOT NULL REFERENCES sessions(id),
    name TEXT NOT NULL,
    slug TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    sell_prices JSONB DEFAULT '[]'::jsonb,
    buy_prices JSONB DEFAULT '[]'::jsonb,
    avg_sell INTEGER DEFAULT 0, -- stored as platinum * 100 for precision
    avg_buy INTEGER DEFAULT 0,  -- stored as platinum * 100 for precision
    market_url TEXT,
    source TEXT NOT NULL CHECK (source IN ('screenshot', 'excel')),
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id ON sessions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_session_id ON inventory_items(session_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_name ON inventory_items(name);

-- Sample query to verify setup
-- SELECT 'Database setup completed successfully' as status;

-- View table structures
-- \d users
-- \d sessions  
-- \d inventory_items

-- View all tables
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';