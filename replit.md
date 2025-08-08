# Overview

This is a Warframe inventory management Telegram bot that analyzes game screenshots and Excel files to help players track their inventory items with real-time market pricing. The bot uses AI to extract item information from screenshots, integrates with the Warframe Market API for pricing data, and provides Excel export/import functionality for inventory management.

## Recent Changes (January 2025)
- Completely rebuilt as a pure Telegram bot (removed web interface)
- Implemented session-based user isolation with PostgreSQL database
- Added three operation modes: oneshot, multishot, and edit
- Integrated Gemini AI for screenshot analysis with structured JSON output
- Built comprehensive Warframe Market API integration with item caching
- Created Excel generation and parsing capabilities with proper column formatting
- Database tables: users, sessions, inventory_items with proper relations
- **Latest Updates:**
  - Fixed Excel column structure to match screenshot format (6 columns vs 7)
  - Added duplicate item consolidation logic for both screenshots and sessions
  - Improved Excel import to handle missing slugs (Russian-only names)
  - Enhanced Telegram menu flow with mandatory session creation
  - Added comprehensive error handling and market data enrichment
  - Created SQL setup file for Neon PostgreSQL database initialization
- **Migration Fixes (August 2025):**
  - Successfully migrated from Replit Agent to Replit environment
  - Fixed database schema mismatches (ARRAY vs JSONB types)
  - Added missing slug field implementation throughout codebase
  - Resolved item consolidation issues with price updates
  - Fixed Excel TypeScript buffer handling with proper type casting
  - Verified complete session isolation by telegram_id
  - Created DATABASE_ARCHITECTURE_GUIDE.md with complete flow documentation
  - Confirmed all consolidation logic works correctly (3+3=6 quantity, price updates)
- **Price Update Feature (August 2025):**
  - Added standalone price update functionality for old Excel files
  - Users can upload existing Excel files to get updated market prices
  - Preserves original item names and quantities while refreshing pricing data
  - Uses full session isolation for data integrity
  - Added new menu option and comprehensive help documentation
- **Excel Splitting Feature (August 2025):**
  - Added Excel file splitting by price thresholds
  - Users upload Excel file and specify price threshold (e.g., 12 platinum)
  - Creates two files: high_price.xlsx and low_price.xlsx
  - Logic: items with ≥3 sell prices above threshold go to high_price file
  - Full session-based processing with proper cleanup
  - Created comprehensive DATABASE_SETUP_GUIDE.md for PostgreSQL setup
- **Database Quality Verification (August 2025):**
  - Comprehensive database integrity check completed
  - All session types work correctly (create→process→cleanup)
  - Perfect user isolation by telegram_id confirmed
  - Zero orphaned records, all data properly linked
  - Created DATABASE_MIGRATION_GUIDE.md for Supabase/Neon PostgreSQL migration
  - Database ready for production deployment
- **Session Management Enhancement (August 2025):**
  - Fixed oneshot mode to strictly allow only one screenshot per session
  - Added screenshot limits: 16 max for multishot and edit modes
  - Implemented forced session completion when limits are reached
  - Added rate limiting with p-limit for API calls (2 concurrent Warframe Market, 3 Gemini)
  - Enhanced session tracking with mode, screenshotProcessed, and screenshotCount flags
  - Prevented API overload issues that caused 429 errors during stress testing
  - Removed artificial item count limits within screenshots to handle larger inventories (18+ items per screenshot)
  - Maintained session isolation and proper database cleanup after limits reached
  - Added 2MB Excel file size limit with user-friendly error handling and recommendations
  - Comprehensive retry logic with exponential backoff for both Gemini AI and Warframe Market APIs
  - Added /status command for users to check current session progress and item counts
- **Database Schema Enhancement (August 2025):**
  - Added proper database constraints (CHECK constraints) matching SQL schema
  - Configured CASCADE delete behavior for data integrity
  - Enhanced Drizzle schema to match production PostgreSQL constraints exactly
- **Final Schema Modernization (August 2025):**
  - Successfully removed oneshot mode completely from database constraints
  - Fixed API key configuration (GEMINI_API_KEY → GOOGLE_API_KEY) for proper authentication
  - Verified database constraints properly reject oneshot attempts
  - All sessions now have photoLimit (16) and expiresAt (1 hour) fields populated
  - Background cleanup system operational for expired sessions
  - Production-ready with complete session lifecycle management
- **Enhanced /start Command Logic (August 2025):**
  - Fixed screenshot queue overflow issue (users could exceed 16 limit)
  - Added pre-queue limit validation to prevent adding screenshots beyond limit
  - Enhanced /start command to force-complete active sessions with Excel generation
  - When /start is pressed mid-session, bot exports processed data and clears queue
  - Proper session isolation: old data exported, queue cleared, new session clean
  - Formula: (processed + queue + new) ≤ 16 screenshots enforced strictly
- **Bot Simplification - Oneshot Mode Removal (August 2025):**
  - Removed oneshot mode completely from the Telegram bot
  - All screenshot analysis now uses multishot mode with 16 screenshot limit
  - Added 1-hour session expiration with automatic completion
  - Simplified menu interface to remove oneshot option
  - Updated help documentation and status commands
  - Enhanced session lifecycle management with proper cleanup
  - Fixed photo handler to automatically complete sessions at limits
- **Database Schema Modernization (August 2025):**
  - Added photoLimit and expiresAt fields to sessions table
  - Updated Drizzle schema to match production database constraints
  - Implemented background cleanup for expired sessions (5-minute intervals)
  - Enhanced storage interface with getExpiredSessions method
  - All session creation now includes proper expiration times and photo limits

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **React + TypeScript**: Modern React application with TypeScript for type safety
- **Vite**: Fast development server and build tool with hot module replacement
- **shadcn/ui**: Component library built on Radix UI primitives with Tailwind CSS styling
- **TanStack Query**: Data fetching and caching for API interactions
- **Wouter**: Lightweight routing solution for client-side navigation

## Backend Architecture
- **Express.js + TypeScript**: RESTful API server with TypeScript support
- **Telegraf**: Telegram Bot API framework for bot interactions
- **Node.js ESM**: Modern ES modules for better tree-shaking and performance

## Data Storage Solutions
- **PostgreSQL**: Primary database using Neon serverless PostgreSQL
- **Drizzle ORM**: Type-safe ORM with schema-first approach
- **Database Schema**: Users, sessions, and inventory items with relational structure

## Authentication and Authorization
- **Telegram Authentication**: Bot authenticates users through Telegram user IDs
- **Session Management**: Simple in-memory session storage for bot interactions
- **User Management**: Automatic user creation and session tracking

## External Dependencies

### AI Services
- **Google Generative AI (Gemini)**: Screenshot analysis and item extraction using vision models with structured JSON output

### Game APIs
- **Warframe Market API**: Real-time pricing data, item information, and market statistics
- **Caching Strategy**: In-memory item cache for performance optimization

### File Processing
- **ExcelJS**: Excel file generation and parsing for inventory import/export
- **XLSX**: Client-side Excel file processing capabilities

### Database
- **Neon PostgreSQL**: Serverless PostgreSQL database with connection pooling
- **Drizzle Kit**: Database migrations and schema management

### UI/UX Libraries
- **Radix UI**: Accessible component primitives (dialogs, dropdowns, forms, etc.)
- **Tailwind CSS**: Utility-first CSS framework with design system
- **Lucide React**: Icon library for consistent iconography
- **React Hook Form**: Form state management with validation

### Development Tools
- **ESBuild**: Fast JavaScript bundler for production builds
- **TSX**: TypeScript execution for development server
- **PostCSS**: CSS processing with Tailwind integration