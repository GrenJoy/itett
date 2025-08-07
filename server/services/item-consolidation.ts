import { type InsertInventoryItem, type InventoryItem } from '@shared/schema';

export function consolidateItems(newItems: InsertInventoryItem[], existingItems: InventoryItem[]): InsertInventoryItem[] {
  const consolidated: InsertInventoryItem[] = [];
  const existingMap = new Map<string, InventoryItem>();
  
  // Create map of existing items by normalized name
  existingItems.forEach(item => {
    const normalizedName = normalizeItemName(item.name);
    existingMap.set(normalizedName, item);
  });
  
  // Process new items
  newItems.forEach(newItem => {
    const normalizedName = normalizeItemName(newItem.name);
    const existing = existingMap.get(normalizedName);
    
    if (existing) {
      // Item exists - consolidate quantities and update prices if newer data is available
      consolidated.push({
        ...newItem,
        quantity: (existing.quantity || 0) + (newItem.quantity || 1),
        // CRITICAL: Always use NEW market data when available (fixes price update issue)
        sellPrices: newItem.sellPrices || existing.sellPrices || [],
        buyPrices: newItem.buyPrices || existing.buyPrices || [],
        avgSell: newItem.avgSell || existing.avgSell || 0,
        avgBuy: newItem.avgBuy || existing.avgBuy || 0,
        marketUrl: newItem.marketUrl || existing.marketUrl,
        slug: newItem.slug || existing.slug
      });
      
      // Remove from existing map so we don't duplicate
      existingMap.delete(normalizedName);
    } else {
      // New item - add as is
      consolidated.push(newItem);
    }
  });
  
  // Add remaining existing items that weren't consolidated
  existingMap.forEach(existingItem => {
    consolidated.push({
      sessionId: newItems[0]?.sessionId || existingItem.sessionId,
      name: existingItem.name,
      slug: existingItem.slug,
      quantity: existingItem.quantity || 1,
      sellPrices: (existingItem.sellPrices && Array.isArray(existingItem.sellPrices)) ? existingItem.sellPrices : [],
      buyPrices: (existingItem.buyPrices && Array.isArray(existingItem.buyPrices)) ? existingItem.buyPrices : [],
      avgSell: existingItem.avgSell || 0,
      avgBuy: existingItem.avgBuy || 0,
      marketUrl: existingItem.marketUrl,
      source: existingItem.source as "screenshot" | "excel"
    });
  });
  
  return consolidated;
}

export function consolidateNewItems(items: InsertInventoryItem[]): InsertInventoryItem[] {
  const consolidated = new Map<string, InsertInventoryItem>();
  
  items.forEach(item => {
    const normalizedName = normalizeItemName(item.name);
    const existing = consolidated.get(normalizedName);
    
    if (existing) {
      // Consolidate quantities
      existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
      // Keep the first occurrence's other data
    } else {
      consolidated.set(normalizedName, { ...item });
    }
  });
  
  return Array.from(consolidated.values());
}

function normalizeItemName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace('ё', 'е')
    // Handle common variations
    .replace(/прайм/g, 'prime')
    .replace(/prime/g, 'прайм')
    .replace(/\(чертеж\)/gi, '(чертёж)')
    .replace(/\(чертёж\)/gi, '(чертеж)')
    .replace(/система/g, 'systems')
    .replace(/systems/g, 'система');
}