import { Telegraf, Context, Markup } from 'telegraf';
import { storage } from './storage';
import { analyzeWarframeScreenshot } from './services/gemini';
import { generateExcelBuffer, parseExcelBuffer } from './services/excel';
import { consolidateItems, consolidateNewItems } from './services/item-consolidation';
import { type InsertInventoryItem } from '@shared/schema';
import { processItemForMarket, getCorrectedItemName } from './services/warframe-market';
import { generateExcelBuffer, parseExcelBuffer, generateTextContent } from './services/excel';

function parseTextToItems(text: string): { name: string; quantity: number }[] {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  
  return lines.map(line => {
    const parts = line.split('|');
    const name = parts[0].trim();
    const quantity = parts.length > 1 && !isNaN(parseInt(parts[1])) ? parseInt(parts[1].trim()) : 1;
    return { name, quantity };
  });
}

// --- ФУНКЦИЯ 2: Центральная "фабрика" обработки предметов ---
async function processRawItems(ctx: BotContext, rawItems: { name: string; quantity: number }[]) {
  if (!ctx.session?.sessionId) {
    await ctx.reply('Произошла ошибка сессии. Пожалуйста, начните заново /start');
    return;
  }
  
  if (rawItems.length === 0) {
    await ctx.reply('Не найдено предметов для обработки.');
    return;
  }
  
  const loadingMessage = await ctx.reply(`🔍 Найдено предметов: ${rawItems.length}\n⏳ Проверяю названия и получаю цены...`);

  const consolidatedItems = new Map<string, InsertInventoryItem>();
  const unrecognizedItems: string[] = [];
  
  for (const rawItem of rawItems) {
    const correctedName = getCorrectedItemName(rawItem.name);
    
    if (correctedName) {
      if (consolidatedItems.has(correctedName)) {
        consolidatedItems.get(correctedName)!.quantity += rawItem.quantity;
      } else {
        const marketItem = await processItemForMarket(correctedName);
        const newItem: InsertInventoryItem = {
          sessionId: ctx.session!.sessionId!,
          name: correctedName,
          quantity: rawItem.quantity,
          slug: marketItem?.slug || null,
          sellPrices: marketItem?.sellPrices || [],
          buyPrices: marketItem?.buyPrices || [],
          avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0,
          avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
          marketUrl: marketItem?.marketUrl || null,
          source: 'screenshot' as const // Можно оставить так, т.к. источник - сессия, а не файл
        };
        consolidatedItems.set(correctedName, newItem);
      }
    } else {
      unrecognizedItems.push(rawItem.name);
    }
  }

  const newEnrichedItems = Array.from(consolidatedItems.values());

  const existingItems = await storage.getItemsBySessionId(ctx.session.sessionId);
  const finalItems = consolidateItems(newEnrichedItems, existingItems);

  await storage.deleteItemsBySessionId(ctx.session.sessionId);
  await storage.createInventoryItems(finalItems);
  
  const finalTotalItems = await storage.getItemsBySessionId(ctx.session.sessionId);
    
  let responseText = `✅ Данные обработаны!\n`;
  responseText += `⚙️ Опознано и добавлено: ${newEnrichedItems.length}\n`;
  if (unrecognizedItems.length > 0) {
    responseText += `⚠️ Не удалось опознать: ${unrecognizedItems.length}\n`;
  }
  responseText += `📋 Всего в сессии: ${finalTotalItems.length}\n\n`;

  if (unrecognizedItems.length > 0) {
    responseText += `*Неопознанные предметы:*\n`;
    for (const itemName of unrecognizedItems.slice(0, 5)) {
      responseText += `• \`${itemName}\`\n`;
    }
    if (unrecognizedItems.length > 5) {
      responseText += `...и еще ${unrecognizedItems.length - 5}.\n`;
    }
    responseText += `\n💡 Вы можете скопировать эти названия, исправить их и отправить мне текстом в формате \`Название|Количество\`, чтобы добавить их вручную.\n`;
  }

  // Удаляем сообщение "Проверяю названия..."
  await ctx.deleteMessage(loadingMessage.message_id);

  // Ответ пользователю
  if (ctx.session?.mode !== 'oneshot') {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
      [Markup.button.callback('❌ Отменить', 'cancel_session')]
    ]);
    await ctx.reply(responseText, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(responseText, { parse_mode: 'Markdown' });
  }
}

interface BotContext extends Context {
  session?: {
    sessionId?: string;
    waitingForExcel?: boolean;
    waitingForPriceUpdate?: boolean;
    waitingForSplitPrice?: boolean;
    splitThreshold?: number;
    mode?: 'oneshot' | 'multishot' | 'edit' | 'price_update' | 'split_excel';
    screenshotProcessed?: boolean;
    screenshotCount?: number;
    lastExport?: {
      excel: string;
      text: string;
      itemsCount: number;
    }
  };
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const bot = new Telegraf<BotContext>(process.env.TELEGRAM_BOT_TOKEN);

const sessions = new Map<string, any>();
bot.use((ctx, next) => {
  const chatId = ctx.chat?.id.toString();
  if (chatId) {
    if (!sessions.has(chatId)) {
      sessions.set(chatId, {});
    }
    ctx.session = sessions.get(chatId);
  }
  return next();
});

// Start command
bot.start(async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('❌ Не удалось определить ваш ID. Попробуйте снова.');
    return;
  }

  // Cancel any existing session
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    await storage.updateSessionStatus(existingSession.id, 'cancelled');
    console.log(`Cancelled session ${existingSession.id} for user ${telegramId}`);
  }

  // Reset session
  ctx.session = {};

  // Create or get user
  let user = await storage.getUserByTelegramId(telegramId);
  if (!user) {
    user = await storage.createUser({
      telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
    });
  }

  const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Создать новую сессию', 'create_session')],
    [Markup.button.callback('❓ Помощь', 'help')]
  ]);

  await ctx.reply(
    '🎮 *Warframe Inventory Analyzer*\n\n' +
    'Добро пожаловать в бота для анализа инвентаря Warframe!\n\n' +
    '🔍 *Возможности:*\n' +
    '• Анализ скриншотов инвентаря\n' +
    '• Получение актуальных цен с Warframe Market\n' +
    '• Экспорт данных в Excel файлы\n' +
    '• Объединение дубликатов предметов\n' +
    '• 💰 Обновление цен в старых Excel файлах\n' +
    '• 📊 Разделение Excel по ценовым порогам\n' +
    '• Создал: GrendematriX. Для связи discord:grenjoy\n\n' +
    '*Выберите действие:*',
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

// Remove old handlers - they are now integrated into session flow

// Create session menu
bot.action('create_session', async (ctx) => {
  await ctx.answerCbQuery();
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎯 Одноразовый анализ', 'mode_oneshot')],
    [Markup.button.callback('📊 Многоразовый анализ', 'mode_multishot')],
    [Markup.button.callback('📝 Редактирование Excel', 'mode_edit')],
    [Markup.button.callback('💰 Обновить цены в Excel', 'mode_update_prices')],
    [Markup.button.callback('📊 Разделить Excel по ценам', 'mode_split_excel')],
    [Markup.button.callback('🔙 Назад', 'back_to_menu')]
  ]);

  await ctx.editMessageText(
    '🎯 *Выберите тип сессии:*\n\n' +
    '*🎯 Одноразовый анализ*\n' +
    'Отправляете скриншоты → получаете Excel файл → сессия завершается\n\n' +
    '*📊 Многоразовый анализ*\n' +
    'Накапливаете предметы из разных скриншотов → завершаете кнопкой\n\n' +
    '*📝 Редактирование Excel*\n' +
    'Загружаете существующий Excel → добавляете новые скриншоты → получаете обновленный файл\n\n' +
    '*💰 Обновление цен*\n' +
    'Загружаете старый Excel → получаете файл с актуальными ценами\n\n' +
    '*📊 Разделение Excel*\n' +
    'Разделяете Excel файл по ценовым порогам на два файла\n\n' +
    'ℹ️ *Каждая сессия изолирована и не влияет на данные других пользователей*',
    { parse_mode: 'Markdown', ...keyboard }
  );
});

// Mode selection handlers
bot.action('mode_oneshot', async (ctx) => {
  await ctx.answerCbQuery();
  await startSession(ctx, 'oneshot');
});

bot.action('mode_multishot', async (ctx) => {
  await ctx.answerCbQuery();
  await startSession(ctx, 'multishot');
});

bot.action('mode_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await startEditSession(ctx);
});

bot.action('mode_update_prices', async (ctx) => {
  await ctx.answerCbQuery();
  await startPriceUpdateSession(ctx);
});

bot.action('mode_split_excel', async (ctx) => {
  await ctx.answerCbQuery();
  await startSplitExcelSession(ctx);
});

// Back to menu handler
bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  
  const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Создать новую сессию', 'create_session')],
    [Markup.button.callback('❓ Помощь', 'help')]
  ]);

  await ctx.editMessageText(
    '🎮 *Warframe Inventory Analyzer*\n\n' +
    'Добро пожаловать в бота для анализа инвентаря Warframe!\n\n' +
    '🔍 *Возможности:*\n' +
    '• ИИ-анализ скриншотов инвентаря\n' +
    '• Получение актуальных цен с Warframe Market\n' +
    '• Экспорт данных в Excel файлы\n' +
    '• Объединение дубликатов предметов\n' +
    '• 💰 Обновление цен в старых Excel файлах\n' +
    '• 📊 Разделение Excel по ценовым порогам\n' +
    '• Создал: GrendematriX. Для связи discord:grenjoy\n\n' +
    '*Выберите действие:*',
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery(); // Рекомендуется добавлять, чтобы убрать "часики" с кнопки
  await ctx.editMessageText(
    '📋 *Инструкция по использованию:*\n\n' +
    '*Одноразовый режим:*\n' +
    '• Отправьте скриншоты инвентаря\n' +
    '• Получите Excel файл с анализом\n' +
    '• Данные автоматически очищаются\n\n' +
    '*Многоразовый режим:*\n' +
    '• Отправляйте скриншоты постепенно\n' +
    '• Данные накапливаются\n' +
    '• Нажмите "Завершить" для получения Excel\n\n' +
    '*Редактирование:*\n' +
    '• Загрузите существующий Excel файл\n' +
    '• Добавьте новые скриншоты\n' +
    '• Получите объединенный файл\n\n' +
    '*💰 Обновление цен:*\n' +
    '• Загрузите старый Excel файл\n' +
    '• Получите файл с обновленными ценами\n' +
    '• Количества остаются прежними\n\n' +
    '*📊 Разделение Excel:*\n' +
    '• Загрузите Excel файл с ценами\n' +
    '• Укажите пороговую цену (например: 12)\n' +
    // ИЗМЕНЕНИЕ ЗДЕСЬ:
    '• Получите 2 файла: `high_price` и `low_price`\n' +
    // И ИЗМЕНЕНИЕ ЗДЕСЬ:
    '• Логика: 3+ цены выше порога → `high_price`\n\n' +
    '*📊 Дополнительные команды:*\n' +
    '• `/status` - показать статус текущей сессии\n\n' +
    'Поддерживаемые форматы: JPG, PNG, WEBP\n' +
    'Excel файлы: .xlsx, .xls',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'back_to_menu')]]) }
  );
});

// Status command
bot.command('status', async (ctx) => {
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии.\n\n💡 Используйте /start для создания новой сессии');
    return;
  }

  try {
    const session = await storage.getSession(ctx.session.sessionId);
    const items = await storage.getItemsBySessionId(ctx.session.sessionId);
    
    let modeText = 'Не определен';
    let maxScreenshots = 1;
    
    if (ctx.session.mode) {
      switch (ctx.session.mode) {
        case 'oneshot':
          modeText = '🎯 Одноразовый';
          maxScreenshots = 1;
          break;
        case 'multishot':
          modeText = '📊 Многоразовый';
          maxScreenshots = 16;
          break;
        case 'edit':
          modeText = '📝 Редактирование';
          maxScreenshots = 16;
          break;
      }
    } else if (session?.type) {
      switch (session.type) {
        case 'price_update':
          modeText = '💰 Обновление цен';
          maxScreenshots = 0;
          break;
        case 'split_excel':
          modeText = '📊 Разделение Excel';
          maxScreenshots = 0;
          break;
      }
    }
    
    const screenshotCount = ctx.session.screenshotCount || 0;
    const sessionStatus = session?.status || 'активна';
    
    let statusMessage = `📊 *Статус сессии:*\n\n`;
    statusMessage += `🎮 Режим: ${modeText}\n`;
    
    if (maxScreenshots > 0) {
      statusMessage += `📸 Скриншотов: ${screenshotCount}/${maxScreenshots}\n`;
    }
    
    statusMessage += `📋 Предметов в сессии: ${items.length}\n`;
    statusMessage += `⚡ Статус: ${sessionStatus}\n`;
    
    if (ctx.session.waitingForExcel) {
      statusMessage += `📎 Ожидание: Excel файл\n`;
    } else if (ctx.session.waitingForPriceUpdate) {
      statusMessage += `📎 Ожидание: Excel для обновления цен\n`;
    } else if (ctx.session.waitingForSplitPrice) {
      statusMessage += `📎 Ожидание: пороговая цена для разделения\n`;
    }
    
    // Show some recent items if any
    if (items.length > 0) {
      statusMessage += `\n🎯 *Последние предметы:*\n`;
      const recentItems = items.slice(-5);
      for (const item of recentItems) {
        statusMessage += `• ${item.name} (${item.quantity})\n`;
      }
      if (items.length > 5) {
        statusMessage += `... и еще ${items.length - 5} предметов\n`;
      }
    }
    
    await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Error getting session status:', error);
    await ctx.reply('❌ Ошибка при получении статуса сессии');
  }
});

bot.action('download_txt', async (ctx) => {
  // @ts-ignore
  const lastExport = ctx.session?.lastExport;
  if (!lastExport?.text) {
    await ctx.answerCbQuery('Данные для экспорта устарели.', { show_alert: true });
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]]).reply_markup
    );
    return;
  }
  await ctx.answerCbQuery();
  const textBuffer = Buffer.from(lastExport.text, 'utf-8');
  await ctx.replyWithDocument(
    { source: textBuffer, filename: `inventory_${Date.now()}.txt` },
    { caption: `📋 Ваш инвентарь в .txt\n📊 Предметов: ${lastExport.itemsCount}` }
  );
  ctx.session = {}; // ПОЛНАЯ ОЧИСТКА СЕССИИ
  await ctx.editMessageText(
    `✅ Файл .txt отправлен!\n\nНажмите /start, чтобы создать новую сессию.`,
    Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
  );
});

bot.action('download_xlsx', async (ctx) => {
  await ctx.answerCbQuery();

  if (!ctx.session?.lastExport?.excel || !ctx.session?.sessionId) {
    await ctx.editMessageText(
      '❌ Нет данных для экспорта или сессия не найдена.\n\nНажмите /start, чтобы начать заново.',
      Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
    );
    ctx.session = {};
    return;
  }

  const excelBuffer = Buffer.from(ctx.session.lastExport.excel, 'base64');
  const lastExport = ctx.session.lastExport;
  const sessionId = ctx.session.sessionId;

  // Complete session in database
  await storage.updateSessionStatus(sessionId, 'completed');

  // Send file
  await ctx.replyWithDocument(
    { source: excelBuffer, filename: `inventory_${Date.now()}.xlsx` },
    { caption: `📊 Ваш инвентарь в .xlsx\n📊 Предметов: ${lastExport.itemsCount}` }
  );

  // Reset session
  ctx.session = {};

  await ctx.editMessageText(
    `✅ Файл .xlsx отправлен!\n\nНажмите /start, чтобы создать новую сессию.`,
    Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
  );
});

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Reset session state
  ctx.session = { sessionId: undefined, waitingForExcel: false, waitingForPriceUpdate: false, waitingForSplitPrice: false };
  
  const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Создать новую сессию', 'create_session')],
    [Markup.button.callback('❓ Помощь', 'help')]
  ]);

  await ctx.editMessageText(
    '🎮 *Warframe Inventory Analyzer*\n\n' +
    'Добро пожаловать в бота для анализа инвентаря Warframe!\n\n' +
    '🔍 *Возможности:*\n' +
    '• ИИ-анализ скриншотов инвентаря\n' +
    '• Получение актуальных цен с Warframe Market\n' +
    '• Экспорт данных в Excel файлы\n' +
    '• Объединение дубликатов предметов\n' +
    '• 💰 Обновление цен в старых Excel файлах\n' +
    '• 📊 Разделение Excel по ценовым порогам\n' +
    '• Создал: GrendematriX. Для связи discord:grenjoy\n\n' +
    '*Выберите действие:*',
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

// Complete session handler
bot.action('complete_session', async (ctx) => {
  await completeSession(ctx);
});

// Cancel session handler
bot.action('cancel_session', async (ctx) => {
  await cancelSession(ctx);
});

async function startSession(ctx: BotContext, type: 'oneshot' | 'multishot') {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Cancel any existing active session
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    await storage.updateSessionStatus(existingSession.id, 'cancelled');
  }

  // Get user
  const user = await storage.getUserByTelegramId(telegramId);
  if (!user) return;

  // Create new session
  const session = await storage.createSession({
    userId: user.id,
    telegramId,
    type,
    status: 'active'
  });

  ctx.session = {
  sessionId: session.id,
  mode: type,
  screenshotProcessed: false,
  screenshotCount: 0,
  waitingForExcel: false,       // <-- исправлено
  waitingForPriceUpdate: false,
  waitingForSplitPrice: false
  };

  const keyboard = type === 'multishot' 
    ? Markup.inlineKeyboard([
        [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
        [Markup.button.callback('❌ Отменить', 'cancel_session')]
      ])
    : Markup.inlineKeyboard([[Markup.button.callback('❌ Отменить', 'cancel_session')]]);

  const modeText = type === 'oneshot' ? 'одноразовый' : 'многоразовый';
  const limitText = type === 'multishot' ? '\n⚠️ Максимум 16 скриншотов за сессию' : '\n⚠️ Только один скриншот в данном режиме';
  
  await ctx.editMessageText(
    `🎯 Запущен ${modeText} режим анализа\n\n` +
    `📸 Отправьте скриншоты инвентаря Warframe\n` +
    `Поддерживаемые форматы: JPG, PNG, WEBP${limitText}\n\n` +
    `${type === 'multishot' ? '💡 Вы можете отправлять скриншоты по частям и завершить сессию кнопкой ниже' : '💡 После отправки скриншота вы автоматически получите Excel файл'}`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function startEditSession(ctx: BotContext) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Cancel any existing active session
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    await storage.updateSessionStatus(existingSession.id, 'cancelled');
  }

  // Get user
  const user = await storage.getUserByTelegramId(telegramId);
  if (!user) return;

  // Create new session
  const session = await storage.createSession({
    userId: user.id,
    telegramId,
    type: 'edit',
    status: 'active'
  });

  ctx.session!.sessionId = session.id;
  ctx.session!.waitingForExcel = true;
  ctx.session!.mode = 'edit';
  ctx.session!.screenshotCount = 0;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отменить', 'cancel_session')]]);

  await ctx.editMessageText(
    '📝 Режим редактирования Excel\n\n' +
    '📄 Сначала отправьте Excel файл (.xlsx), который вы ранее выгрузили из бота. Файлы .txt для этого режима не подходят.\n' +
    'После этого вы сможете добавить новые скриншоты\n' +
    '⚠️ Максимум 16 скриншотов за сессию',
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function startPriceUpdateSession(ctx: BotContext) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Cancel any existing active session
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    await storage.updateSessionStatus(existingSession.id, 'cancelled');
  }

  // Get user
  const user = await storage.getUserByTelegramId(telegramId);
  if (!user) return;

  // Create new session
  const session = await storage.createSession({
    userId: user.id,
    telegramId,
    type: 'price_update',
    status: 'active'
  });

  ctx.session!.sessionId = session.id;
  ctx.session!.waitingForExcel = true;
  ctx.session!.waitingForPriceUpdate = true;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отменить', 'cancel_session')]]);

  await ctx.editMessageText(
    '💰 *Обновление цен в Excel файле*\n\n' +
    '📋 *Как это работает:*\n' +
    '1. Отправьте Excel файл с инвентарем\n' +
    '2. Бот извлечет названия и количества предметов\n' +
    '3. Получит актуальные цены с Warframe Market\n' +
    '4. Вернет обновленный Excel с новыми ценами\n' +
    '5. Сессия автоматически завершится и очистится\n\n' +
    '📎 *Отправьте Excel файл для обновления цен:*',
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function startSplitExcelSession(ctx: BotContext) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  // Cancel any existing active session
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    await storage.updateSessionStatus(existingSession.id, 'cancelled');
  }

  // Get user
  const user = await storage.getUserByTelegramId(telegramId);
  if (!user) return;

  // Create new session
  const session = await storage.createSession({
    userId: user.id,
    telegramId,
    type: 'split_excel',
    status: 'active'
  });

  ctx.session!.sessionId = session.id;
  ctx.session!.waitingForExcel = true;
  ctx.session!.waitingForSplitPrice = false;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отменить', 'cancel_session')]]);

  await ctx.editMessageText(
    '📊 *Разделение Excel по ценам*\n\n' +
    '📋 *Как это работает:*\n' +
    '1. Отправьте Excel файл с инвентарем\n' +
    '2. Укажите пороговую цену для разделения\n' +
    '3. Получите 2 файла: high_price.xlsx и low_price.xlsx\n\n' +
    '💡 *Логика разделения:*\n' +
    '• Если у предмета 3+ цены выше порога → попадает в high_price\n' +
    '• Иначе остается в low_price\n\n' +
    '📎 *Отправьте Excel файл:*',
    { parse_mode: 'Markdown', ...keyboard }
  );
}

async function completeSession(ctx: BotContext) {
  if (ctx.callbackQuery) { await ctx.answerCbQuery(); }
  if (!ctx.session?.sessionId) {
    await ctx.reply('Нет активной сессии для завершения.');
    return;
  }

  const sessionId = ctx.session.sessionId;
  const session = await storage.getSession(sessionId);
  const items = await storage.getItemsBySessionId(sessionId);

  // Исключаем split_excel из стандартной логики завершения
  if (session?.type === 'split_excel') {
    await ctx.reply('❌ Для режима разделения Excel используйте ввод пороговой цены.');
    return;
  }

  if (items.length === 0) {
    await ctx.reply('❌ В сессии нет предметов для экспорта. Сессия завершена.');
    await storage.updateSessionStatus(sessionId, 'completed');
    ctx.session = {};
    return;
  }

  try {
    // Генерируем Excel-файл
    const excelBuffer = await generateExcelBuffer(items);
    const MAX_FILE_SIZE = 2 * 1024 * 1024;

    // Проверка размера Excel-файла
    if (excelBuffer.byteLength > MAX_FILE_SIZE) {
      const fileSizeMB = (excelBuffer.byteLength / (1024 * 1024)).toFixed(2);
      await storage.updateSessionStatus(sessionId, 'completed');

      // Генерируем текстовый файл как запасной вариант
      let textContent;
      try {
        textContent = generateTextContent(items);
      } catch (error) {
        console.error('Error generating text content:', error);
        await ctx.reply('❌ Ошибка при создании текстового файла.');
        ctx.session = {};
        return;
      }

      const textBuffer = Buffer.from(textContent, 'utf-8');

      // Проверка размера текстового файла
      if (textBuffer.byteLength > MAX_FILE_SIZE) {
        const textFileSizeMB = (textBuffer.byteLength / (1024 * 1024)).toFixed(2);
        const tooLargeMessage = `⚠️ *Файлы слишком большие!*\n\n` +
          `📊 Предметов в сессии: ${items.length}\n` +
          `📁 Размер Excel: ${fileSizeMB} MB (макс. 2 MB)\n` +
          `📄 Размер текста: ${textFileSizeMB} MB (макс. 2 MB)\n\n` +
          `💡 *Рекомендации:*\n` +
          `• Используйте несколько сессий для большого инвентаря.\n\n` +
          `Сессия завершена без отправки файлов.`;

        if (ctx.callbackQuery) {
          await ctx.editMessageText(tooLargeMessage, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
          });
        } else {
          await ctx.reply(tooLargeMessage, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
          });
        }
        ctx.session = {};
        return;
      }

      ctx.session = {};

      const tooLargeMessage = `⚠️ *Файл Excel слишком большой!*\n\n` +
        `📊 Предметов в сессии: ${items.length}\n` +
        `📁 Размер файла: ${fileSizeMB} MB (макс. 2 MB)\n\n` +
        `💡 *Рекомендации:*\n` +
        `• Используйте несколько сессий для большого инвентаря.\n` +
        `• Текстовый файл отправлен как запасной вариант.\n\n` +
        `Сессия завершена.`;

      if (ctx.callbackQuery) {
        await ctx.editMessageText(tooLargeMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
        });
      } else {
        await ctx.reply(tooLargeMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
        });
      }

      await ctx.replyWithDocument(
        { source: textBuffer, filename: `inventory_${Date.now()}.txt` },
        { caption: `📋 Ваш инвентарь в .txt (запасной вариант)\n📊 Предметов: ${items.length}` }
      );
      return;
    }

    // Логика для oneshot
    if (session?.type === 'oneshot') {
      await storage.updateSessionStatus(sessionId, 'completed');
      ctx.session = {};

      await ctx.reply(`✅ Сессия завершена!\n📊 Найдено предметов: ${items.length}`);
      await ctx.replyWithDocument(
        { source: excelBuffer, filename: `inventory_${Date.now()}.xlsx` },
        { caption: `📋 Ваш инвентарь Warframe\n📊 Предметов: ${items.length}` }
      );
    } else {
      // Логика для multishot, edit, price_update
      let textContent;
      try {
        textContent = generateTextContent(items);
      } catch (error) {
        console.error('Error generating text content:', error);
        await ctx.reply('❌ Ошибка при создании текстового файла. Попробуйте скачать Excel.');
        return;
      }

      const textBuffer = Buffer.from(textContent, 'utf-8');
      if (textBuffer.byteLength > MAX_FILE_SIZE) {
        const textFileSizeMB = (textBuffer.byteLength / (1024 * 1024)).toFixed(2);
        await storage.updateSessionStatus(sessionId, 'completed');
        ctx.session = {};

        const tooLargeMessage = `⚠️ *Текстовый файл слишком большой!*\n\n` +
          `📊 Предметов в сессии: ${items.length}\n` +
          `📄 Размер текста: ${textFileSizeMB} MB (макс. 2 MB)\n\n` +
          `💡 *Рекомендации:*\n` +
          `• Используйте несколько сессий для большого инвентаря.\n\n` +
          `Сессия завершена без отправки файлов.`;

        if (ctx.callbackQuery) {
          await ctx.editMessageText(tooLargeMessage, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
          });
        } else {
          await ctx.reply(tooLargeMessage, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
          });
        }
        return;
      }

      ctx.session.lastExport = {
        excel: excelBuffer.toString('base64'),
        text: textContent,
        itemsCount: items.length
      };
      await storage.updateSessionStatus(sessionId, 'completed');

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('📄 Скачать .txt', 'download_txt'),
        Markup.button.callback('📊 Скачать .xlsx', 'download_xlsx')
      ]);

      let messageText = `✅ Сессия завершена!\nНайдено предметов: ${items.length}.\n\nВыберите формат для скачивания:`;
      if (session?.type === 'price_update') {
        messageText = `✅ Цены обновлены!\nНайдено предметов: ${items.length}.\n\nВыберите формат для скачивания:`;
      }

      if (ctx.callbackQuery) {
        await ctx.editMessageText(messageText, { reply_markup: keyboard.reply_markup });
      } else {
        await ctx.reply(messageText, keyboard);
      }
    }
  } catch (error) {
    console.error('Error completing session:', error);
    await ctx.reply('❌ Ошибка при создании файлов для экспорта.');
  }
}

// Handle photos
bot.on('photo', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии. Нажмите /start, чтобы начать.');
    return;
  }

  // Check session status
  const session = await storage.getSession(ctx.session.sessionId);
  if (!session || session.status !== 'active') {
    ctx.session = {};
    await ctx.reply('❌ Сессия завершена или не найдена. Нажмите /start, чтобы начать новую.');
    return;
  }
  if (ctx.session.waitingForExcel) {
    await ctx.reply('❌ Сначала отправьте Excel файл');
    return;
  }
  if (ctx.session.mode === 'oneshot' && ctx.session.screenshotProcessed) {
    await ctx.reply('❌ В режиме одноразового анализа можно отправить только один скриншот. Сессия завершена.');
    await completeSession(ctx);
    return;
  }
  const MAX_SCREENSHOTS = 16;
  if ((ctx.session.mode === 'multishot' || ctx.session.mode === 'edit') && (ctx.session.screenshotCount || 0) >= MAX_SCREENSHOTS) {
    await ctx.reply(`❌ Превышен лимит скриншотов (${MAX_SCREENSHOTS}). Завершаю сессию...`);
    await completeSession(ctx);
    return;
  }

  try {
    const loadingMessage = await ctx.reply('🔄 Анализирую скриншот...');
    
    ctx.session.screenshotCount = (ctx.session.screenshotCount || 0) + 1;
    
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    const fileInfo = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    const base64Image = Buffer.from(buffer).toString('base64');

    const rawExtractedItems = await analyzeWarframeScreenshot(base64Image);
    
    if (rawExtractedItems.length === 0) {
      await ctx.deleteMessage(loadingMessage.message_id);
      await ctx.reply('❌ На скриншоте не найдено предметов Warframe.');
      if (ctx.session.mode === 'oneshot') {
        ctx.session.screenshotProcessed = true;
        await completeSession(ctx);
      }
      return;
    }

    await ctx.telegram.editMessageText(ctx.chat!.id, loadingMessage.message_id, undefined, `🔍 Распознано предметов: ${rawExtractedItems.length}\n⏳ Проверяю названия и получаю цены...`);

    const consolidatedItems = new Map<string, InsertInventoryItem>();
    const unrecognizedItems: string[] = [];
    
    for (const rawItem of rawExtractedItems) {
      const correctedName = getCorrectedItemName(rawItem.name);
      if (correctedName) {
        if (consolidatedItems.has(correctedName)) {
          consolidatedItems.get(correctedName)!.quantity += rawItem.quantity;
        } else {
          const marketItem = await processItemForMarket(correctedName);
          const newItem: InsertInventoryItem = {
            sessionId: ctx.session!.sessionId!, name: correctedName, quantity: rawItem.quantity,
            slug: marketItem?.slug || null, sellPrices: marketItem?.sellPrices || [], buyPrices: marketItem?.buyPrices || [],
            avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0, avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
            marketUrl: marketItem?.marketUrl || null, source: 'screenshot' as const
          };
          consolidatedItems.set(correctedName, newItem);
        }
      } else {
        unrecognizedItems.push(rawItem.name);
      }
    }
    
    const newEnrichedItems = Array.from(consolidatedItems.values());
    const existingItems = await storage.getItemsBySessionId(ctx.session.sessionId!);
    const finalItems = consolidateItems(newEnrichedItems, existingItems);

    await storage.deleteItemsBySessionId(ctx.session.sessionId!);
    await storage.createInventoryItems(finalItems);

    const finalTotalItems = await storage.getItemsBySessionId(ctx.session.sessionId!);
    
    let responseText = `✅ Скриншот обработан!\n`;
    responseText += `📊 Распознано на скриншоте: ${rawExtractedItems.length}\n`;
    responseText += `⚙️ Из них опознано и добавлено: ${newEnrichedItems.length}\n`;
    responseText += `📋 Всего в сессии: ${finalTotalItems.length}\n`;
    responseText += `📸 Скриншотов: ${ctx.session.screenshotCount}/${MAX_SCREENSHOTS}\n\n`;
    
    if (unrecognizedItems.length > 0) {
      responseText += `⚠️ *Не удалось опознать ${unrecognizedItems.length} предмет(ов):*\n`;
      for (const itemName of unrecognizedItems.slice(0, 5)) {
        responseText += `• \`${itemName}\`\n`;
      }
      if (unrecognizedItems.length > 5) {
        responseText += `...и еще ${unrecognizedItems.length - 5}.\n`;
      }
      // ↓↓↓ ВАША ГЕНИАЛЬНАЯ ПОДСКАЗКА ↓↓↓
      responseText += `\n💡 Вы можете скопировать эти названия, исправить их и отправить мне текстом в формате \`Название|Количество\`, чтобы добавить их вручную.\n\n`;
    }
    
    const itemsToShow = newEnrichedItems.slice(0, 5);
    if (itemsToShow.length > 0) {
      responseText += '🎯 Добавленные предметы:\n';
      for (const item of itemsToShow) {
        responseText += `• ${item.name} (${item.quantity})\n`;
      }
      if (newEnrichedItems.length > 5) {
        responseText += `... и еще ${newEnrichedItems.length - 5} предметов\n`;
      }
    } else if (unrecognizedItems.length === 0) {
      responseText += '❌ Ни одного предмета не удалось опознать.\n'
    }

    await ctx.deleteMessage(loadingMessage.message_id);

    if (ctx.session.mode === 'oneshot') {
      ctx.session.screenshotProcessed = true;
      await ctx.reply(responseText, { parse_mode: 'Markdown' });
      await completeSession(ctx);
    } else if (ctx.session.screenshotCount >= MAX_SCREENSHOTS) {
      await ctx.reply(responseText + '\n⚠️ Достигнут лимит скриншотов. Завершаю сессию...', { parse_mode: 'Markdown' });
      await completeSession(ctx);
    } else {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
        [Markup.button.callback('❌ Отменить', 'cancel_session')]
      ]);
      await ctx.reply(responseText, { parse_mode: 'Markdown', ...keyboard });
    }

  } catch (error) {
    console.error('Error processing photo:', error);
    await ctx.reply('❌ Ошибка при обработке скриншота.');
    if (ctx.session.mode === 'oneshot' && ctx.session) {
      ctx.session.screenshotProcessed = true;
      await completeSession(ctx);
    }
  }
});

// Handle documents (Excel files)
bot.on('document', async (ctx) => {
  if (!ctx.session?.sessionId || !ctx.session.waitingForExcel) {
    await ctx.reply('❌ Сначала выберите режим работы командой /start');
    return;
  }

  // Get session to determine mode
  const session = await storage.getSession(ctx.session.sessionId);
  
  // Handle price update mode
  if (session?.type === 'price_update') {
    await handlePriceUpdateDocument(ctx);
    return;
  }

  // Handle split Excel mode
  if (session?.type === 'split_excel') {
    await handleSplitExcelDocument(ctx);
    return;
  }

  // Handle edit mode (existing functionality)

  const document = ctx.message.document;
  const fileName = document.file_name || '';
  
  if (!fileName.match(/\.(xlsx?|xls)$/i)) {
    await ctx.reply('❌ Поддерживаются только Excel файлы (.xlsx, .xls)');
    return;
  }

  try {
    await ctx.reply('📄 Загружаю Excel файл...');
    
    // Download file
    const fileInfo = await ctx.telegram.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Parse Excel file
    const excelItems = await parseExcelBuffer(buffer);
    
    if (excelItems.length === 0) {
      await ctx.reply('❌ Excel файл не содержит данных или имеет неправильный формат');
      return;
    }

    // Convert to inventory items and enrich with market data when possible
    const inventoryItems: InsertInventoryItem[] = [];
    
    await ctx.reply(`🔄 Обогащаю данные из Warframe Market...`);
    
    for (const item of excelItems) {
      let marketItem = null;
      
      // Try to find market data by Russian name
      try {
        marketItem = await processItemForMarket(item.name);
      } catch (error) {
        console.warn(`Could not find market data for Excel item: ${item.name}`);
      }
      
      inventoryItems.push({
        sessionId: ctx.session!.sessionId!,
        name: item.name,
        slug: marketItem?.slug || null,
        quantity: item.quantity,
        sellPrices: typeof item.sellPrices === 'string' ? item.sellPrices.split(',').map((p: string) => parseFloat(p.trim())).filter((p: number) => !isNaN(p)) : (marketItem?.sellPrices || []),
        buyPrices: typeof item.buyPrices === 'string' ? item.buyPrices.split(',').map((p: string) => parseFloat(p.trim())).filter((p: number) => !isNaN(p)) : (marketItem?.buyPrices || []),
        avgSell: item.avgSell ? Math.round(item.avgSell * 100) : (marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0),
        avgBuy: item.avgBuy ? Math.round(item.avgBuy * 100) : (marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0),
        marketUrl: item.marketUrl || marketItem?.marketUrl || null,
        source: 'excel' as const
      });
    }

    // Save to database
    await storage.createInventoryItems(inventoryItems);

    ctx.session.waitingForExcel = false;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
      [Markup.button.callback('❌ Отменить', 'cancel_session')]
    ]);

    await ctx.reply(
      `✅ Excel файл загружен!\n` +
      `📊 Импортировано предметов: ${excelItems.length}\n\n` +
      `📸 Теперь можете отправлять скриншоты для добавления новых предметов`,
      keyboard
    );

  } catch (error) {
    console.error('Error processing Excel file:', error);
    await ctx.reply('❌ Ошибка при обработке Excel файла. Проверьте формат файла.');
  }
});



// Handle price update document processing
async function handlePriceUpdateDocument(ctx: BotContext) {
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии');
    return;
  }

  const document = (ctx.message as any)?.document;
  const fileName = document?.file_name || '';
  
  if (!fileName.match(/\.(xlsx?|xls)$/i)) {
    await ctx.reply('❌ Поддерживаются только Excel файлы (.xlsx, .xls)');
    return;
  }

  try {
    await ctx.reply('📄 Загружаю Excel файл...');
    
    // Download file
    const fileInfo = await ctx.telegram.getFile(document!.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Parse Excel file to extract names and quantities
    const excelItems = await parseExcelBuffer(buffer);
    
    if (excelItems.length === 0) {
      await ctx.reply('❌ Excel файл не содержит данных или имеет неправильный формат');
      return;
    }

    await ctx.reply(`🔄 Обновляю цены для ${excelItems.length} предметов...`);
    
    // Convert to inventory items and enrich with market data
    const inventoryItems: InsertInventoryItem[] = [];
    
    for (const item of excelItems) {
      const marketItem = await processItemForMarket(item.name);
      
      inventoryItems.push({
        sessionId: ctx.session.sessionId,
        name: item.name,
        slug: marketItem?.slug || null,
        quantity: item.quantity,
        sellPrices: marketItem?.sellPrices || [],
        buyPrices: marketItem?.buyPrices || [],
        avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0,
        avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
        marketUrl: marketItem?.marketUrl || null,
        source: 'excel' as const
      });
    }

    // Save to database with session isolation
    await storage.createInventoryItems(inventoryItems);

    // Generate Excel with fresh prices (inventoryItems will be converted internally)
    const items = await storage.getItemsBySessionId(ctx.session.sessionId);
    const updatedBuffer = await generateExcelBuffer(items);

    // Auto-complete the price update session
    await completeSession(ctx);

  } catch (error) {
    console.error('Error updating prices:', error);
    await ctx.reply('❌ Ошибка при обновлении цен. Проверьте формат Excel файла.');
  }
}

// Handle split Excel document processing
async function handleSplitExcelDocument(ctx: BotContext) {
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии');
    return;
  }

  const document = (ctx.message as any)?.document;
  const fileName = document?.file_name || '';
  
  if (!fileName.match(/\.(xlsx?|xls)$/i)) {
    await ctx.reply('❌ Поддерживаются только Excel файлы (.xlsx, .xls)');
    return;
  }

  try {
    await ctx.reply('📄 Загружаю Excel файл...');
    
    // Download file
    const fileInfo = await ctx.telegram.getFile(document!.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Parse Excel file
    const excelItems = await parseExcelBuffer(buffer);
    
    if (excelItems.length === 0) {
      await ctx.reply('❌ Excel файл не содержит данных или имеет неправильный формат');
      return;
    }

    // Convert to inventory items and enrich with market data
    const inventoryItems: InsertInventoryItem[] = [];
    
    await ctx.reply(`🔄 Обогащаю данные из Warframe Market...`);
    
    for (const item of excelItems) {
      let marketItem = null;
      
      // Try to find market data by Russian name
      try {
        marketItem = await processItemForMarket(item.name);
      } catch (error) {
        console.warn(`Could not find market data for Excel item: ${item.name}`);
      }
      
      // Get 5 current sell prices from market
      const sellPrices = marketItem?.sellPrices?.slice(0, 5) || [];
      
      inventoryItems.push({
        sessionId: ctx.session!.sessionId!,
        name: item.name,
        slug: marketItem?.slug || null,
        quantity: item.quantity,
        sellPrices: sellPrices, // Use fresh market data
        buyPrices: marketItem?.buyPrices || [],
        avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0,
        avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
        marketUrl: marketItem?.marketUrl || null,
        source: 'excel' as const
      });
    }

    // Save to database
    await storage.createInventoryItems(inventoryItems);
    
    ctx.session.waitingForExcel = false;
    ctx.session.waitingForSplitPrice = true;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Отменить', 'cancel_session')]
    ]);

    await ctx.reply(
      `✅ Excel файл загружен!\n` +
      `📊 Найдено предметов: ${excelItems.length}\n\n` +
      `💰 Введите пороговую цену для разделения:\n` +
      `Например: 12\n\n` +
      `💡 Предметы с порогом равному или выше вашему попадут в high_price.xlsx`,
      keyboard
    );

  } catch (error) {
    console.error('Error processing split Excel file:', error);
    await ctx.reply('❌ Ошибка при обработке Excel файла. Проверьте формат файла.');
  }
}

// Handle Excel splitting logic
async function handleExcelSplit(ctx: BotContext) {
  if (!ctx.session?.sessionId || ctx.session.splitThreshold === undefined) {
    await ctx.reply('❌ Ошибка: нет данных для разделения');
    return;
  }

  try {
    await ctx.reply(`🔄 Разделяю Excel по порогу ${ctx.session.splitThreshold} платины...`);

    const sessionId = ctx.session.sessionId;
    const threshold = ctx.session.splitThreshold;
    const items = await storage.getItemsBySessionId(sessionId);

    const highPriceItems: typeof items = [];
    const lowPriceItems: typeof items = [];

    for (const item of items) {
      const sellPrices = Array.isArray(item.sellPrices) ? item.sellPrices : [];
      // Take first 5 sell prices and check how many are >= threshold
      const first5Prices = sellPrices.slice(0, 5);
      const pricesAboveThreshold = first5Prices.filter(price => price >= threshold);
      
      // If 3 or more prices are above threshold, move to high_price
      if (pricesAboveThreshold.length >= 3) {
        highPriceItems.push(item);
      } else {
        lowPriceItems.push(item);
      }
    }

    // Generate Excel files
    const highPriceBuffer = await generateExcelBuffer(highPriceItems);
    const lowPriceBuffer = await generateExcelBuffer(lowPriceItems);

    // Complete session and cleanup
    await storage.updateSessionStatus(sessionId, 'completed');
    ctx.session = {};

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🆕 Создать новую сессию', 'create_session')]
    ]);

    await ctx.reply(
      `✅ Excel разделен!\n` +
      `📊 Всего предметов: ${items.length}\n` +
      `📈 Высокие цены (${threshold}+): ${highPriceItems.length}\n` +
      `📉 Низкие цены (<${threshold}): ${lowPriceItems.length}\n\n` +
      `📎 Ваши файлы:`,
      keyboard
    );
    
    // Send both Excel files
    await ctx.replyWithDocument(
      { source: highPriceBuffer, filename: `high_price_${threshold}p_${Date.now()}.xlsx` },
      { caption: `📈 Предметы с высокими ценами (${threshold}+ платины)\n📊 Предметов: ${highPriceItems.length}` }
    );

    await ctx.replyWithDocument(
      { source: lowPriceBuffer, filename: `low_price_${threshold}p_${Date.now()}.xlsx` },
      { caption: `📉 Предметы с низкими ценами (<${threshold} платины)\n📊 Предметов: ${lowPriceItems.length}` }
    );

  } catch (error) {
    console.error('Error splitting Excel:', error);
    await ctx.reply('❌ Ошибка при разделении Excel файла.');
  }
}

// Handle text messages (for split price threshold)
bot.on('text', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии. Нажмите /start, чтобы начать.');
    return;
  }

  // Проверка статуса сессии в хранилище
  const session = await storage.getSession(ctx.session.sessionId);
  if (!session || session.status !== 'active') {
    ctx.session = {};
    await ctx.reply('❌ Сессия завершена или не найдена. Нажмите /start, чтобы начать новую.');
    return;
  }

  // Обработка порога цены для split_excel
  if (ctx.session?.waitingForSplitPrice) {
    const priceText = ctx.message.text.trim();
    const price = parseFloat(priceText);
    if (isNaN(price) || price <= 0) {
      await ctx.reply('❌ Введите корректное число больше 0.');
      return;
    }
    ctx.session.splitThreshold = price;
    ctx.session.waitingForSplitPrice = false;
    await handleExcelSplit(ctx);
    return;
  }

  // Проверяем, активна ли сессия и подходит ли режим для добавления текстом
  if (!ctx.session?.sessionId || (ctx.session.mode !== 'multishot' && ctx.session.mode !== 'edit')) {
    if (!ctx.message.text.startsWith('/')) {
      await ctx.reply('💡 Чтобы добавить предметы текстом, начните сессию "Многоразовый анализ" или "Редактирование Excel".');
    }
    return;
  }

  try {
    const loadingMessage = await ctx.reply('🔄 Обрабатываю ваш текст...');

    // Парсим текст с помощью вашей функции
    const itemsFromText = parseTextToItems(ctx.message.text);

    if (itemsFromText.length === 0) {
      await ctx.deleteMessage(loadingMessage.message_id);
      await ctx.reply('Не найдено предметов для добавления в вашем сообщении.\n' + '💡 Отправьте текст в формате: Название|Количество, например:\n' + 'Висп Прайм: Каркас|2\nСевагот Прайм: Система|1' );
      return;
    }

    // Обрабатываем элементы с помощью вашей функции processRawItems
    await processRawItems(ctx, itemsFromText);

    // Удаляем сообщение о загрузке, так как processRawItems уже отправляет ответ
    await ctx.deleteMessage(loadingMessage.message_id);

  } catch (error) {
    console.error('Error processing text input:', error);
    await ctx.reply('❌ Ошибка при обработке вашего текста.');
  }
});


// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Произошла ошибка. Попробуйте еще раз или обратитесь к администратору.');
});

export { bot };
