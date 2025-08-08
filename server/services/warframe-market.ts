// Файл: market.ts
// Версия: Финальная, с чтением из файла и функцией-корректором

import { type WarframeMarketItem } from "@shared/schema";
import pLimit from "p-limit";
import fs from 'fs';
import path from 'path';

const WFM_BASE_URL = "https://api.warframe.market/v2";
const limit = pLimit(2); // Limit to 2 concurrent requests to prevent 429 errors
const HEADERS = {
  'Platform': 'pc',
  'Language': 'ru',
  'User-Agent': 'Warframe-Inventory-Checker/Telegram-Bot-v1'
};

interface WFMItem {
  slug: string;
  i18n: {
    ru: {
      name: string;
    };
  };
}

interface WFMOrderData {
  sell: Array<{ platinum: number }>;
  buy: Array<{ platinum: number }>;
}

let itemsCache: Map<string, WFMItem> = new Map();

export function normalizeString(text: string): string {
  if (!text) return "";
  return text.toLowerCase().replace('ё', 'е').trim()
    .replace(/\s*:\s*/, ': ')
    .replace(/\s+/, ' ');
}

// УЛУЧШЕННАЯ ФУНКЦИЯ ЗАГРУЗКИ КЭША
export async function loadItemsCache(): Promise<void> {
  const filePath = path.join(process.cwd(), 'data', 'items.json');
  
  try {
    // 1. Пытаемся прочитать локальный файл
    console.log(`Загрузка кэша предметов из локального файла: ${filePath}`);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const items = JSON.parse(fileContent);
    
    itemsCache.clear();
    for (const item of items) {
      const itemNameRu = item.i18n?.ru?.name;
      if (itemNameRu) {
        itemsCache.set(normalizeString(itemNameRu), item);
      }
    }
    console.log(`✅ Кэш успешно загружен из файла: ${itemsCache.size} предметов.`);
    
  } catch (fileError) {
    // 2. Если файл не найден или ошибка - идем в интернет как запасной вариант
    console.warn(`⚠️ Локальный файл не найден или поврежден. Загружаю кэш из API Warframe Market...`);
    
    try {
      const response = await fetch(`${WFM_BASE_URL}/items`, { headers: HEADERS });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      const items = data.data || [];
      
      itemsCache.clear();
      for (const item of items) {
        const itemNameRu = item.i18n?.ru?.name;
        if (itemNameRu) {
          itemsCache.set(normalizeString(itemNameRu), item);
        }
      }
      console.log(`✅ Кэш успешно загружен из API: ${itemsCache.size} предметов.`);
    } catch (apiError) {
      console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось загрузить кэш ни из файла, ни из API.', apiError);
      throw new Error('Failed to load Warframe Market items cache.');
    }
  }
}

export function findItemSlug(itemName: string): string | null {
  const normalizedName = normalizeString(itemName);
  const item = itemsCache.get(normalizedName);
  return item?.slug || null;
}

export async function getItemPrices(slug: string): Promise<WarframeMarketItem | null> {
  try {
    const url = `${WFM_BASE_URL}/orders/item/${slug}/top`;
    const response = await fetch(url, { headers: HEADERS });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    const orderData: WFMOrderData = data.data || { sell: [], buy: [] };
    
    const sellPrices = orderData.sell.map(order => order.platinum);
    const buyPrices = orderData.buy.map(order => order.platinum);
    
    const avgSell = sellPrices.length > 0 
      ? Math.round((sellPrices.reduce((a, b) => a + b, 0) / sellPrices.length) * 100) / 100
      : 0;
    
    const avgBuy = buyPrices.length > 0
      ? Math.round((buyPrices.reduce((a, b) => a + b, 0) / buyPrices.length) * 100) / 100
      : 0;

    const cacheItem = Array.from(itemsCache.values()).find(item => item.slug === slug);
    const name = cacheItem?.i18n?.ru?.name || slug;
    
    return {
      slug,
      name,
      sellPrices,
      buyPrices,
      avgSell,
      avgBuy,
      marketUrl: `https://warframe.market/ru/items/${slug}`
    };
  } catch (error) {
    console.error(`Failed to get prices for ${slug}:`, error);
    return null;
  }
}

async function retryWarframeMarketRequest<T>(
  operation: () => Promise<T>, 
  maxRetries: number = 3,
  baseDelay: number = 2000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      const statusMatch = error.message?.match(/HTTP (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      
      if (status === 429 || status >= 500) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`Warframe Market API error ${status}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached');
}

export async function processItemForMarket(itemName: string): Promise<WarframeMarketItem | null> {
  return limit(async () => {
    return retryWarframeMarketRequest(async () => {
      const slug = findItemSlug(itemName);
      if (!slug) {
        // Убрали console.log отсюда, чтобы не спамить. Логирование будет в getCorrectedItemName.
        return null;
      }
      
      return await getItemPrices(slug);
    });
  });
}

// НОВАЯ ФУНКЦИЯ-КОРРЕКТОР ("МОЗГ")
export function getCorrectedItemName(rawName: string): string | null {
  if (!rawName) return null;

  let processedName = rawName.trim();

  // 1. Применяем жесткие правила для чертежей
  if (processedName.toLowerCase().startsWith('чертёж:')) {
    processedName = processedName.substring(7).trim() + " (Чертеж)";
  }
  
  // 2. Проверяем на точное совпадение в кэше
  const normalizedProcessedName = normalizeString(processedName);
  if (itemsCache.has(normalizedProcessedName)) {
    // Возвращаем официальное, красивое название из кэша
    return itemsCache.get(normalizedProcessedName)!.i18n.ru.name;
  }

  // 3. Если ничего не нашли, логируем ошибку.
  // В будущем сюда можно добавить `string-similarity` для исправления опечаток
  console.warn(`[Corrector] Не удалось найти точное совпадение для: "${rawName}" -> "${processedName}"`);
  return null;
}


// Initialize cache on module load
loadItemsCache().catch(console.error);