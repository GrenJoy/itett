import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, jsonb, timestamp, boolean, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  telegramId: text("telegram_id").notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  telegramId: text("telegram_id").notNull(),
  type: text("type", { enum: ["oneshot", "multishot", "edit", "price_update", "split_excel"] }).notNull(),
  status: text("status", { enum: ["active", "completed", "cancelled"] }).default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  typeCheck: check("type_check", sql`${table.type} IN ('oneshot', 'multishot', 'edit', 'price_update', 'split_excel')`),
  statusCheck: check("status_check", sql`${table.status} IN ('active', 'completed', 'cancelled')`),
}));

export const inventoryItems = pgTable("inventory_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").references(() => sessions.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  slug: text("slug"), // Warframe Market item slug - may be null for items not found
  quantity: integer("quantity").notNull().default(1),
  sellPrices: jsonb("sell_prices").$type<number[]>().default(sql`'[]'::jsonb`),
  buyPrices: jsonb("buy_prices").$type<number[]>().default(sql`'[]'::jsonb`),
  avgSell: integer("avg_sell").default(0), // in platinum * 100 for precision
  avgBuy: integer("avg_buy").default(0), // in platinum * 100 for precision
  marketUrl: text("market_url"),
  source: text("source", { enum: ["screenshot", "excel"] }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sourceCheck: check("source_check", sql`${table.source} IN ('screenshot', 'excel')`),
}));

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  items: many(inventoryItems),
}));

export const inventoryItemsRelations = relations(inventoryItems, ({ one }) => ({
  session: one(sessions, {
    fields: [inventoryItems.sessionId],
    references: [sessions.id],
  }),
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).pick({
  telegramId: true,
  username: true,
  firstName: true,
  lastName: true,
});

export const insertSessionSchema = createInsertSchema(sessions).pick({
  userId: true,
  telegramId: true,
  type: true,
  status: true,
});

export const insertInventoryItemSchema = createInsertSchema(inventoryItems).pick({
  sessionId: true,
  name: true,
  slug: true,
  quantity: true,
  sellPrices: true,
  buyPrices: true,
  avgSell: true,
  avgBuy: true,
  marketUrl: true,
  source: true,
}).extend({
  sellPrices: z.array(z.number()).optional(),
  buyPrices: z.array(z.number()).optional(),
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Session = typeof sessions.$inferSelect;
export type InsertSession = z.infer<typeof insertSessionSchema>;

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;

// Warframe Market API types
export interface WarframeMarketItem {
  slug: string;
  name: string;
  sellPrices: number[];
  buyPrices: number[];
  avgSell: number;
  avgBuy: number;
  marketUrl: string;
}
