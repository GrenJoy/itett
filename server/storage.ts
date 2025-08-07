import { users, sessions, inventoryItems, type User, type InsertUser, type Session, type InsertSession, type InventoryItem, type InsertInventoryItem } from "@shared/schema";
import { db } from "./db";
import { eq, and } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByTelegramId(telegramId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Session operations
  getSession(id: string): Promise<Session | undefined>;
  getActiveSessionByTelegramId(telegramId: string): Promise<Session | undefined>;
  createSession(session: InsertSession): Promise<Session>;
  updateSessionStatus(id: string, status: "active" | "completed" | "cancelled"): Promise<void>;
  
  // Inventory item operations
  getItemsBySessionId(sessionId: string): Promise<InventoryItem[]>;
  createInventoryItem(item: InsertInventoryItem): Promise<InventoryItem>;
  createInventoryItems(items: InsertInventoryItem[]): Promise<InventoryItem[]>;
  deleteItemsBySessionId(sessionId: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByTelegramId(telegramId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id));
    return session || undefined;
  }

  async getActiveSessionByTelegramId(telegramId: string): Promise<Session | undefined> {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.telegramId, telegramId),
        eq(sessions.status, "active")
      ));
    return session || undefined;
  }

  async createSession(insertSession: InsertSession): Promise<Session> {
    const [session] = await db
      .insert(sessions)
      .values(insertSession)
      .returning();
    return session;
  }

  async updateSessionStatus(id: string, status: "active" | "completed" | "cancelled"): Promise<void> {
    await db
      .update(sessions)
      .set({ 
        status, 
        completedAt: status === "completed" ? new Date() : null 
      })
      .where(eq(sessions.id, id));
  }

  async getItemsBySessionId(sessionId: string): Promise<InventoryItem[]> {
    return await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.sessionId, sessionId));
  }

  async createInventoryItem(insertItem: InsertInventoryItem): Promise<InventoryItem> {
    const [item] = await db
      .insert(inventoryItems)
      .values([insertItem])
      .returning();
    return item;
  }

  async createInventoryItems(insertItems: InsertInventoryItem[]): Promise<InventoryItem[]> {
    if (insertItems.length === 0) return [];
    
    return await db
      .insert(inventoryItems)
      .values(insertItems)
      .returning();
  }

  async deleteItemsBySessionId(sessionId: string): Promise<void> {
    await db
      .delete(inventoryItems)
      .where(eq(inventoryItems.sessionId, sessionId));
  }
}

export const storage = new DatabaseStorage();
