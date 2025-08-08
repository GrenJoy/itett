import { type InsertInventoryItem, type InventoryItem } from '@shared/schema';

// ↓↓↓ ЭТА ФУНКЦИЯ ПОЛНОСТЬЮ ЗАМЕНЕНА НА НОВУЮ, НАДЕЖНУЮ ВЕРСИЮ ↓↓↓
export function consolidateItems(newItems: InsertInventoryItem[], existingItems: InventoryItem[]): InsertInventoryItem[] {
  // Если новых предметов нет, просто возвращаем старые, ничего не меняя
  if (newItems.length === 0) {
    return existingItems as InsertInventoryItem[];
  }

  // Берем sessionId из первого нового предмета. Он будет одинаковый для всех.
  const currentSessionId = newItems[0].sessionId;
  if (!currentSessionId) {
    // Дополнительная защита: если у новых предметов нет sessionId, возвращаем старые
    console.error("Critical error: new items are missing sessionId in consolidateItems");
    return existingItems as InsertInventoryItem[];
  }

  const consolidatedMap = new Map<string, InsertInventoryItem>();
  
  // 1. Сначала добавляем все существующие предметы в Map, чтобы сохранить их порядок и данные
  existingItems.forEach(item => {
    const normalizedName = normalizeItemName(item.name);
    consolidatedMap.set(normalizedName, { ...item });
  });
  
  // 2. Затем обрабатываем новые предметы, обновляя или добавляя их в Map
  newItems.forEach(newItem => {
    const normalizedName = normalizeItemName(newItem.name);
    const existing = consolidatedMap.get(normalizedName);
    
    if (existing) {
      // Если предмет уже есть, обновляем его: суммируем количество и берем свежие данные с маркета
      existing.quantity += newItem.quantity;
      existing.sellPrices = newItem.sellPrices;
      existing.buyPrices = newItem.buyPrices;
      existing.avgSell = newItem.avgSell;
      existing.avgBuy = newItem.avgBuy;
      existing.marketUrl = newItem.marketUrl;
      existing.slug = newItem.slug;
    } else {
      // Если предмета нет, просто добавляем его в Map
      consolidatedMap.set(normalizedName, newItem);
    }
  });

  // 3. Преобразуем Map обратно в массив
  const finalItems = Array.from(consolidatedMap.values());
  
  // Финальная проверка, чтобы у всех предметов был правильный sessionId
  finalItems.forEach(item => item.sessionId = currentSessionId);
  
  return finalItems;
}


// --- Эта функция остается без изменений ---
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


// --- Эта функция остается без изменений ---
function normalizeItemName(name: string): string {
  if (!name) return ''; // Добавлена проверка на пустую строку для надежности
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace('ё', 'е')
    // Handle common variations (эти правила могут конфликтовать, лучше выбрать одно)
    .replace(/\(чертеж\)/gi, '(чертёж)')
    // .replace(/прайм/g, 'prime') // Эти правила могут быть опасны, если у вас есть и русские, и англ. названия
    // .replace(/система/g, 'systems')
}