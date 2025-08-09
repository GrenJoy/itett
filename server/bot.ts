import { Telegraf, Context, Markup } from 'telegraf';
import { storage } from './storage';
import { analyzeWarframeScreenshot } from './services/gemini';
import { generateExcelBuffer, parseExcelBuffer, generateTextContent } from './services/excel';
import { consolidateItems } from './services/item-consolidation';
import { type InsertInventoryItem, type Session } from '@shared/schema';
import { processItemForMarket, getCorrectedItemName } from './services/warframe-market';

const MAX_SCREENSHOTS_PER_SESSION = 16;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 час
const DEBOUNCE_TIMEOUT_MS = 3000; // 3 секунды для дебансинга
const processingLock = new Set<string>();
const photoQueue = new Map<string, string[]>();
const cancellationRequests = new Set<string>();
const userDebounceTimers = new Map<string, NodeJS.Timeout>();
const sessions = new Map<string, any>();

function parseTextToItems(text: string): { name: string; quantity: number }[] {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  return lines.map(line => {
    const parts = line.split('|');
    const name = parts[0].trim();
    const quantity = parts.length > 1 && !isNaN(parseInt(parts[1])) ? parseInt(parts[1].trim()) : 1;
    return { name, quantity };
  });
}

function cleanupSession(ctx: BotContext) {
  const telegramId = ctx.from?.id.toString();
  if (telegramId) {
    photoQueue.delete(telegramId);
    cancellationRequests.delete(telegramId);
    userDebounceTimers.delete(telegramId);
    console.log(`[Cleanup] Cleared resources for user ${telegramId}`);
  }
  ctx.session = {};
  sessions.set(ctx.chat!.id.toString(), ctx.session);
}

async function processRawItems(ctx: BotContext, rawItems: { name: string; quantity: number }[]) {
  if (!ctx.session || !ctx.session.sessionId) {
    await ctx.reply('❌ Сессия не инициализирована. Пожалуйста, начните заново /start');
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
        const existingItem = consolidatedItems.get(correctedName);
        if (existingItem) {
          existingItem.quantity = (existingItem.quantity || 0) + rawItem.quantity;
        }
      } else {
        const marketItem = await processItemForMarket(correctedName);
        const newItem: InsertInventoryItem = {
          sessionId: ctx.session.sessionId,
          name: correctedName,
          quantity: rawItem.quantity,
          slug: marketItem?.slug || null,
          sellPrices: marketItem?.sellPrices || [],
          buyPrices: marketItem?.buyPrices || [],
          avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0,
          avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
          marketUrl: marketItem?.marketUrl || null,
          source: 'screenshot' as const
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
  await ctx.deleteMessage(loadingMessage.message_id);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
    [Markup.button.callback('❌ Отменить', 'cancel_session')]
  ]);
  await ctx.reply(responseText, { parse_mode: 'Markdown', ...keyboard });
}

interface BotContext extends Context {
  session?: {
    sessionId?: string;
    waitingForExcel?: boolean;
    waitingForPriceUpdate?: boolean;
    waitingForSplitPrice?: boolean;
    splitThreshold?: number;
    mode?: 'multishot' | 'edit' | 'price_update' | 'split_excel';
    screenshotProcessed?: boolean;
    screenshotCount?: number;
    batchUnrecognizedItems?: string[];
    batchNewlyAddedCount?: number;
    lastExport?: {
      excel: string;
      text: string;
      itemsCount: number;
    };
  };
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const bot = new Telegraf<BotContext>(process.env.TELEGRAM_BOT_TOKEN);

bot.use((ctx, next) => {
  const chatId = ctx.chat?.id.toString();
  if (chatId) {
    if (!sessions.has(chatId)) {
      sessions.set(chatId, {});
    }
    ctx.session = sessions.get(chatId);
    return next().then(() => {
      sessions.set(chatId, ctx.session);
    });
  }
  return next();
});

bot.start(async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('❌ Не удалось определить ваш ID. Попробуйте снова.');
    return;
  }
  if (photoQueue.has(telegramId)) {
    cancellationRequests.add(telegramId);
    photoQueue.delete(telegramId);
    userDebounceTimers.delete(telegramId);
    console.log(`[STOP] Forced stop of photo queue for user ${telegramId} via /start.`);
  }
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    const existingItems = await storage.getItemsBySessionId(existingSession.id);
    if (existingItems.length > 0) {
      await ctx.reply('⏳ Завершаю текущую сессию и формирую Excel из обработанных данных...');
      try {
        const excelBuffer = await generateExcelBuffer(existingItems);
        await storage.updateSessionStatus(existingSession.id, 'completed');
        await ctx.replyWithDocument(
          { source: excelBuffer, filename: `inventory_${Date.now()}.xlsx` },
          { caption: `📊 Ваш частично обработанный инвентарь\n📊 Предметов: ${existingItems.length}\n\n🆕 Теперь можете создать новую сессию.` }
        );
      } catch (error) {
        console.error('Error generating Excel for forced completion:', error);
        await ctx.reply('❌ Ошибка при формировании Excel файла. Сессия будет завершена без экспорта.');
        await storage.updateSessionStatus(existingSession.id, 'cancelled');
      }
    } else {
      await storage.updateSessionStatus(existingSession.id, 'cancelled');
      console.log(`[DB] Cancelled empty session ${existingSession.id} for user ${telegramId}`);
    }
    cleanupSession(ctx);
  }
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
    '🎮 Warframe Inventory Analyzer\n\n' +
    'Добро пожаловать в бота для анализа инвентаря Warframe!\n\n' +
    '🔍 Возможности:\n' +
    '• Анализ скриншотов инвентаря\n' +
    '• Получение актуальных цен с Warframe Market\n' +
    '• Экспорт данных в Excel файлы\n' +
    '• Объединение дубликатов предметов\n' +
    '• 💰 Обновление цен в старых Excel файлах\n' +
    '• 📊 Разделение Excel по ценовым порогам\n' +
    '• Создал: GrendematriX. Для связи discord:grenjoy\n\n' +
    'Выберите действие:',
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.action('create_session', async (ctx) => {
  await ctx.answerCbQuery();
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Многоразовый анализ', 'mode_multishot')],
    [Markup.button.callback('📝 Редактирование Excel', 'mode_edit')],
    [Markup.button.callback('💰 Обновить цены в Excel', 'mode_update_prices')],
    [Markup.button.callback('📊 Разделить Excel по ценам', 'mode_split_excel')],
    [Markup.button.callback('🔙 Назад', 'back_to_menu')]
  ]);
  await ctx.editMessageText(
    '🎯 Выберите тип сессии:\n\n' +
    '📊 Многоразовый анализ\n' +
    'Накапливаете предметы из разных скриншотов → завершаете кнопкой\n' +
    'Лимит: 16 скриншотов, время сессии: 1 час\n\n' +
    '📝 Редактирование Excel\n' +
    'Загружаете существующий Excel → добавляете новые скриншоты → получаете обновленный файл\n\n' +
    '💰 Обновление цен\n' +
    'Загружаете старый Excel → получаете файл с актуальными ценами\n\n' +
    '📊 Разделение Excel\n' +
    'Разделяете Excel файл по ценовым порогам на два файла\n\n' +
    'ℹ️ Каждая сессия изолирована и не влияет на данные других пользователей',
    { parse_mode: 'Markdown', ...keyboard }
  );
});

bot.action('mode_multishot', async (ctx) => {
  await ctx.answerCbQuery();
  await startSession(ctx, 'multishot');
});

bot.action('mode_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await startSession(ctx, 'edit');
});

bot.action('mode_update_prices', async (ctx) => {
  await ctx.answerCbQuery();
  await startSession(ctx, 'price_update');
});

bot.action('mode_split_excel', async (ctx) => {
  await ctx.answerCbQuery();
  await startSession(ctx, 'split_excel');
});

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Создать новую сессию', 'create_session')],
    [Markup.button.callback('❓ Помощь', 'help')]
  ]);
  await ctx.editMessageText(
    '🎮 Warframe Inventory Analyzer\n\n' +
    'Добро пожаловать в бота для анализа инвентаря Warframe!\n\n' +
    '🔍 Возможности:\n' +
    '• ИИ-анализ скриншотов инвентаря\n' +
    '• Получение актуальных цен с Warframe Market\n' +
    '• Экспорт данных в Excel файлы\n' +
    '• Объединение дубликатов предметов\n' +
    '• 💰 Обновление цен в старых Excel файлах\n' +
    '• 📊 Разделение Excel по ценовым порогам\n' +
    '• Создал: GrendematriX. Для связи discord:grenjoy\n\n' +
    'Выберите действие:',
    { parse_mode: 'Markdown', ...mainKeyboard }
  );
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📋 Инструкция по использованию:\n\n' +
    '📊 Многоразовый режим:\n' +
    '• Отправляйте скриншоты постепенно (до 16 штук)\n' +
    '• Данные накапливаются в течение 1 часа\n' +
    '• Нажмите "Завершить" для получения Excel\n' +
    '• При достижении лимита сессия завершается автоматически\n\n' +
    '📝 Редактирование:\n' +
    '• Загрузите существующий Excel файл\n' +
    '• Добавьте новые скриншоты (до 16 штук)\n' +
    '• Получите объединенный файл\n\n' +
    '💰 Обновление цен:\n' +
    '• Загрузите старый Excel файл\n' +
    '• Получите файл с обновленными ценами\n' +
    '• Количества остаются прежними\n\n' +
    '📊 Разделение Excel:\n' +
    '• Загрузите Excel файл с ценами\n' +
    '• Укажите пороговую цену (например: 12)\n' +
    '• Получите 2 файла: high_price и low_price\n' +
    '• Логика: 3+ цены выше порога → high_price\n\n' +
    '📊 Дополнительные команды:\n' +
    '• /status - показать статус текущей сессии\n\n' +
    'Поддерживаемые форматы: JPG, PNG, WEBP\n' +
    'Excel файлы: .xlsx, .xls',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'back_to_menu')]]) }
  );
});

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
        case 'multishot':
          modeText = '📊 Многоразовый';
          maxScreenshots = 16;
          break;
        case 'edit':
          modeText = '📝 Редактирование';
          maxScreenshots = 16;
          break;
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
    if (ctx.session.batchUnrecognizedItems?.length) {
      statusMessage += `\n⚠️ *Неопознанные предметы в текущей пачке:*\n`;
      for (const item of ctx.session.batchUnrecognizedItems.slice(0, 5)) {
        statusMessage += `• \`${item}\`\n`;
      }
      if (ctx.session.batchUnrecognizedItems.length > 5) {
        statusMessage += `... и еще ${ctx.session.batchUnrecognizedItems.length - 5}\n`;
      }
    }
    if (ctx.session.batchNewlyAddedCount) {
      statusMessage += `\n✅ Добавлено в текущей пачке: ${ctx.session.batchNewlyAddedCount}\n`;
    }
    await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error getting session status:', error);
    await ctx.reply('❌ Ошибка при получении статуса сессии');
  }
});

bot.action('download_txt', async (ctx) => {
  await ctx.answerCbQuery();
  const lastExport = ctx.session?.lastExport;
  if (!lastExport?.text) {
    await ctx.answerCbQuery('Данные для экспорта устарели.', { show_alert: true });
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]]).reply_markup
    );
    return;
  }
  const textBuffer = Buffer.from(lastExport.text, 'utf-8');
  await ctx.replyWithDocument(
    { source: textBuffer, filename: `inventory_${Date.now()}.txt` },
    { caption: `📋 Ваш инвентарь в .txt\n📊 Предметов: ${lastExport.itemsCount}` }
  );
  cleanupSession(ctx);
  await ctx.editMessageText(
    '✅ Файл .txt отправлен!\n\nНажмите /start, чтобы создать новую сессию.',
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
    cleanupSession(ctx);
    return;
  }
  const excelBuffer = Buffer.from(ctx.session.lastExport.excel, 'base64');
  const lastExport = ctx.session.lastExport;
  const sessionId = ctx.session.sessionId;
  await storage.updateSessionStatus(sessionId, 'completed');
  await ctx.replyWithDocument(
    { source: excelBuffer, filename: `inventory_${Date.now()}.xlsx` },
    { caption: `📊 Ваш инвентарь в .xlsx\n📊 Предметов: ${lastExport.itemsCount}` }
  );
  cleanupSession(ctx);
  await ctx.editMessageText(
    '✅ Файл .xlsx отправлен!\n\nНажмите /start, чтобы создать новую сессию.',
    Markup.inlineKeyboard([[Markup.button.callback('🆕 Создать новую сессию', 'create_session')]])
  );
});

bot.action('complete_session', async (ctx) => {
  await completeSession(ctx);
});

bot.action('cancel_session', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (telegramId) {
    cancellationRequests.add(telegramId);
    console.log(`[STOP] Cancellation requested for user ${telegramId} via button.`);
  }
  if (ctx.session?.sessionId) {
    await storage.updateSessionStatus(ctx.session.sessionId, 'cancelled');
  }
  cleanupSession(ctx);
  await ctx.answerCbQuery();
  await ctx.reply('❌ Сессия отменена. Очередь обработки очищена. Нажмите /start, чтобы начать новую.');
});

async function startSession(ctx: BotContext, mode: Session['type']) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('❌ Не удалось определить ваш ID.');
    return;
  }
  const existingSession = await storage.getActiveSessionByTelegramId(telegramId);
  if (existingSession) {
    await storage.updateSessionStatus(existingSession.id, 'cancelled');
  }
  const user = await storage.getUserByTelegramId(telegramId);
  if (!user) {
    await ctx.reply('❌ Пользователь не найден.');
    return;
  }
  const session = await storage.createSession({
    userId: user.id,
    telegramId,
    type: mode,
    status: 'active',
    photoLimit: mode === 'multishot' || mode === 'edit' ? 16 : 0,
    expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS)
  });
  if (!session || !session.id) {
    await ctx.reply('❌ Не удалось создать сессию. Попробуйте позже.');
    throw new Error('Failed to create session');
  }
  console.log(`Created ${mode} session:`, session);
  ctx.session!.sessionId = session.id;
  ctx.session!.mode = mode;
  ctx.session!.screenshotProcessed = false;
  ctx.session!.screenshotCount = 0;
  ctx.session!.waitingForExcel = mode === 'edit' || mode === 'price_update' || mode === 'split_excel';
  ctx.session!.waitingForPriceUpdate = mode === 'price_update';
  ctx.session!.waitingForSplitPrice = false;
  ctx.session!.batchUnrecognizedItems = [];
  ctx.session!.batchNewlyAddedCount = 0;
  sessions.set(ctx.chat!.id.toString(), ctx.session);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
    [Markup.button.callback('❌ Отменить', 'cancel_session')]
  ]);
  let messageText = '';
  switch (mode) {
    case 'multishot':
      messageText = '🎯 Запущен многоразовый режим анализа\n\n' +
        '📸 Отправьте скриншоты инвентаря Warframe\n' +
        'Поддерживаемые форматы: JPG, PNG, WEBP\n' +
        `⚠️ Максимум ${MAX_SCREENSHOTS_PER_SESSION} скриншотов за сессию\n` +
        '⏰ Время сессии: 1 час\n\n' +
        '💡 Вы можете отправлять скриншоты по частям и завершить сессию кнопкой ниже';
      break;
    case 'edit':
      messageText = '📝 Режим редактирования Excel\n\n' +
        '📄 Сначала отправьте Excel файл (.xlsx), который вы ранее выгрузили из бота. Файлы .txt для этого режима не подходят.\n' +
        `⚠️ Максимум ${MAX_SCREENSHOTS_PER_SESSION} скриншотов за сессию`;
      keyboard.reply_markup.inline_keyboard = [[Markup.button.callback('❌ Отменить', 'cancel_session')]];
      break;
    case 'price_update':
      messageText = '💰 Обновление цен в Excel файле\n\n' +
        '📋 Как это работает:\n' +
        '1. Отправьте Excel файл с инвентарем\n' +
        '2. Бот извлечет названия и количества предметов\n' +
        '3. Получит актуальные цены с Warframe Market\n' +
        '4. Вернет обновленный Excel с новыми ценами\n' +
        '5. Сессия автоматически завершится и очистится\n\n' +
        '📎 Отправьте Excel файл для обновления цен:';
      keyboard.reply_markup.inline_keyboard = [[Markup.button.callback('❌ Отменить', 'cancel_session')]];
      break;
    case 'split_excel':
      messageText = '📊 Разделение Excel по ценам\n\n' +
        '📋 Как это работает:\n' +
        '1. Отправьте Excel файл с инвентарем\n' +
        '2. Укажите пороговую цену для разделения\n' +
        '3. Получите 2 файла: high_price.xlsx и low_price.xlsx\n\n' +
        '💡 Логика разделения:\n' +
        '• Если у предмета 3+ цены выше порога → high_price\n' +
        '• Иначе остается в low_price\n\n' +
        '📎 Отправьте Excel файл:';
      keyboard.reply_markup.inline_keyboard = [[Markup.button.callback('❌ Отменить', 'cancel_session')]];
      break;
  }
  await ctx.editMessageText(messageText, { parse_mode: 'Markdown', ...keyboard });
}

async function completeSession(ctx: BotContext) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
  }
  if (!ctx.session?.sessionId) {
    await ctx.reply('Нет активной сессии для завершения.');
    return;
  }
  const sessionId = ctx.session.sessionId;
  const session = await storage.getSession(sessionId);
  if (!session || session.status !== 'active') {
    await ctx.reply('❌ Сессия уже завершена или отменена.');
    cleanupSession(ctx);
    return;
  }
  const items = await storage.getItemsBySessionId(sessionId);
  if (session.type === 'split_excel') {
    await ctx.reply('❌ Для режима разделения Excel используйте ввод пороговой цены.');
    return;
  }
  if (items.length === 0) {
    await ctx.reply('❌ В сессии нет предметов для экспорта. Сессия завершена.');
    await storage.updateSessionStatus(sessionId, 'completed');
    cleanupSession(ctx);
    return;
  }
  try {
    const excelBuffer = await generateExcelBuffer(items);
    if (excelBuffer.byteLength > MAX_FILE_SIZE) {
      const fileSizeMB = (excelBuffer.byteLength / (1024 * 1024)).toFixed(2);
      await storage.updateSessionStatus(sessionId, 'completed');
      let textContent;
      try {
        textContent = generateTextContent(items);
      } catch (error) {
        console.error('Error generating text content:', error);
        await ctx.reply('❌ Ошибка при создании текстового файла.');
        cleanupSession(ctx);
        return;
      }
      const textBuffer = Buffer.from(textContent, 'utf-8');
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
        cleanupSession(ctx);
        return;
      }
      cleanupSession(ctx);
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
    let textContent;
    try {
      textContent = generateTextContent(items);
    } catch (error) {
      console.error('Error generating text content:', error);
      await ctx.reply('❌ Ошибка при создании текстового файла. Попробуйте скачать Excel.');
      cleanupSession(ctx);
      return;
    }
    const textBuffer = Buffer.from(textContent, 'utf-8');
    if (textBuffer.byteLength > MAX_FILE_SIZE) {
      const textFileSizeMB = (textBuffer.byteLength / (1024 * 1024)).toFixed(2);
      await storage.updateSessionStatus(sessionId, 'completed');
      cleanupSession(ctx);
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
    if (ctx.session) {
      ctx.session.lastExport = {
        excel: excelBuffer.toString('base64'),
        text: textContent,
        itemsCount: items.length
      };
      sessions.set(ctx.chat!.id.toString(), ctx.session);
    }
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
  } catch (error) {
    console.error('Error completing session:', error);
    await ctx.reply('❌ Ошибка при создании файлов для экспорта.');
  } finally {
    cleanupSession(ctx);
  }
}

async function sendFinalReport(ctx: BotContext) {
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии для отчета.');
    return;
  }
  const sessionId = ctx.session.sessionId;
  const session = await storage.getSession(sessionId);
  if (!session || session.status !== 'active') {
    await ctx.reply('❌ Сессия уже завершена или отменена.');
    cleanupSession(ctx);
    return;
  }
  const items = await storage.getItemsBySessionId(sessionId);
  const unrecognizedCount = ctx.session.batchUnrecognizedItems?.length || 0;
  const addedCount = ctx.session.batchNewlyAddedCount || 0;
  let responseText = `✅ Пачка скриншотов обработана!\n`;
  responseText += `📸 Скриншотов обработано: ${ctx.session.screenshotCount || 0}/${session.photoLimit}\n`;
  responseText += `⚙️ Добавлено предметов: ${addedCount}\n`;
  responseText += `📋 Всего в сессии: ${items.length}\n`;
  if (unrecognizedCount > 0) {
    responseText += `\n⚠️ *Не удалось опознать ${unrecognizedCount} предмет(ов):*\n`;
    for (const itemName of ctx.session.batchUnrecognizedItems!.slice(0, 5)) {
      responseText += `• \`${itemName}\`\n`;
    }
    if (unrecognizedCount > 5) {
      responseText += `...и еще ${unrecognizedCount - 5}.\n`;
    }
    responseText += `\n💡 Проверьте написание или отправьте исправленные названия в формате \`Название|Количество\`, например: \`Акцельтра Прайм Ствол|1\`.\n`;
  }
  if ((ctx.session.screenshotCount || 0) >= session.photoLimit) {
    responseText += `\n⚠️ Достигнут лимит скриншотов (${session.photoLimit}). Завершаю сессию...`;
    await ctx.reply(responseText, { parse_mode: 'Markdown' });
    await completeSession(ctx);
    return;
  }
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Завершить сессию', 'complete_session')],
    [Markup.button.callback('❌ Отменить', 'cancel_session')]
  ]);
  await ctx.reply(responseText, { parse_mode: 'Markdown', ...keyboard });
}

async function processPhotoQueue(ctx: BotContext) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !ctx.session || !ctx.session.sessionId) {
    console.error(`[Photo Queue] Session not initialized for user ${telegramId}`);
    await ctx.reply('❌ Сессия не инициализирована. Нажмите /start, чтобы начать заново.');
    processingLock.delete(telegramId);
    return;
  }
  if (processingLock.has(telegramId)) {
    console.log(`[Photo Queue] Already processing for user ${telegramId}`);
    return;
  }
  const originalSessionId = ctx.session.sessionId;
  const sessionData = await storage.getSession(originalSessionId);
  if (!sessionData || sessionData.status !== 'active') {
    await ctx.reply('❌ Сессия была завершена или отменена. Очередь скриншотов очищена.');
    cleanupSession(ctx);
    processingLock.delete(telegramId);
    return;
  }
  const MAX_SCREENSHOTS = sessionData.photoLimit || MAX_SCREENSHOTS_PER_SESSION;
  if (MAX_SCREENSHOTS === 0) {
    console.error(`[Photo Queue] Invalid photo limit for user ${telegramId}: ${ctx.session.mode}`);
    await ctx.reply('❌ Ошибка: неверный режим сессии. Нажмите /start, чтобы начать заново.');
    processingLock.delete(telegramId);
    return;
  }
  processingLock.add(telegramId);
  console.log(`[Photo Queue] Started processing for user ${telegramId}, limit: ${MAX_SCREENSHOTS}`);
  try {
    while (photoQueue.has(telegramId) && photoQueue.get(telegramId)!.length > 0) {
      if (cancellationRequests.has(telegramId)) {
        cancellationRequests.delete(telegramId);
        photoQueue.delete(telegramId);
        console.log(`[Worker] Processing stopped for ${telegramId} due to cancellation request.`);
        break;
      }
      const currentScreenshotCount = ctx.session?.screenshotCount || 0;
      if (currentScreenshotCount % 5 === 0) {
        const currentSession = await storage.getSession(originalSessionId);
        if (!currentSession || currentSession.status !== 'active') {
          await ctx.reply('❌ Сессия была завершена или отменена. Очередь скриншотов очищена.');
          cleanupSession(ctx);
          break;
        }
      }
      if ((ctx.session?.screenshotCount || 0) >= MAX_SCREENSHOTS) {
        console.log(`[Worker] Screenshot limit reached for user ${telegramId}, completing session`);
        photoQueue.delete(telegramId);
        await completeSession(ctx);
        break;
      }
      const fileId = photoQueue.get(telegramId)!.shift()!;
      try {
        console.log(`[Worker] Processing photo for user ${telegramId}, mode: ${ctx.session.mode}, screenshotCount: ${(ctx.session.screenshotCount || 0) + 1}/${MAX_SCREENSHOTS}`);
        ctx.session.screenshotCount = (ctx.session.screenshotCount || 0) + 1;
        sessions.set(ctx.chat!.id.toString(), ctx.session);
        const fileInfo = await ctx.telegram.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        const base64Image = Buffer.from(buffer).toString('base64');
        let rawExtractedItems: { name: string; quantity: number }[];
        try {
          rawExtractedItems = await analyzeWarframeScreenshot(base64Image);
        } catch (error: any) {
          if (error.message?.includes('ApiError') && error.status === 403) {
            console.error(`[Photo] API 403 error for user ${telegramId}, fileId: ${fileId}:`, error);
            ctx.session?.batchUnrecognizedItems?.push('API error: Unauthorized access');
            await ctx.reply('❌ Ошибка API при анализе скриншота. Проверьте настройки API или попробуйте позже.');
            continue;
          }
          throw error;
        }
        if (cancellationRequests.has(telegramId)) continue;
        if (rawExtractedItems.length === 0) {
          ctx.session?.batchUnrecognizedItems?.push('No items detected');
          sessions.set(ctx.chat!.id.toString(), ctx.session);
          continue;
        }
        const consolidatedItems = new Map<string, InsertInventoryItem>();
        const unrecognizedItems: string[] = [];
        for (const rawItem of rawExtractedItems) {
          if (cancellationRequests.has(telegramId)) break;
          const correctedName = getCorrectedItemName(rawItem.name);
          if (correctedName) {
            if (consolidatedItems.has(correctedName)) {
              const existingItem = consolidatedItems.get(correctedName);
              if (existingItem) {
                existingItem.quantity = (existingItem.quantity || 0) + rawItem.quantity;
              }
            } else {
              const marketItem = await processItemForMarket(correctedName);
              if (cancellationRequests.has(telegramId)) break;
              const newItem: InsertInventoryItem = {
                sessionId: originalSessionId,
                name: correctedName,
                quantity: rawItem.quantity,
                slug: marketItem?.slug || null,
                sellPrices: marketItem?.sellPrices || [],
                buyPrices: marketItem?.buyPrices || [],
                avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0,
                avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
                marketUrl: marketItem?.marketUrl || null,
                source: 'screenshot' as const
              };
              consolidatedItems.set(correctedName, newItem);
            }
          } else {
            unrecognizedItems.push(rawItem.name);
            console.log(`[Corrector] Не удалось найти точное совпадение для: "${rawItem.name}"`);
          }
        }
        if (cancellationRequests.has(telegramId)) continue;
        const newEnrichedItems = Array.from(consolidatedItems.values());
        const existingItems = await storage.getItemsBySessionId(originalSessionId);
        const finalItems = consolidateItems(newEnrichedItems, existingItems);
        await storage.deleteItemsBySessionId(originalSessionId);
        await storage.createInventoryItems(finalItems);
        if (ctx.session) {
          ctx.session.batchUnrecognizedItems?.push(...unrecognizedItems);
          ctx.session.batchNewlyAddedCount = (ctx.session.batchNewlyAddedCount || 0) + newEnrichedItems.length;
          sessions.set(ctx.chat!.id.toString(), ctx.session);
        }
        console.log(`[Worker] User ${telegramId}: photo processed. Remaining: ${photoQueue.get(telegramId)?.length || 0}`);
      } catch (error: any) {
        console.error(`[Photo] Error analyzing screenshot for user ${telegramId}, fileId: ${fileId}:`, error);
        ctx.session?.batchUnrecognizedItems?.push('Error processing screenshot');
        sessions.set(ctx.chat!.id.toString(), ctx.session);
      }
    }
  } finally {
    await sendFinalReport(ctx);
    processingLock.delete(telegramId);
    if (cancellationRequests.has(telegramId)) {
      cancellationRequests.delete(telegramId);
    }
    console.log(`[Photo Queue] Finished processing batch for user ${telegramId}`);
  }
}

async function startBatchProcessing(ctx: BotContext) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    console.error('[Batch] No telegramId in context');
    await ctx.reply('❌ Ошибка: не удалось определить ваш ID. Нажмите /start, чтобы начать заново.');
    return;
  }
  if (processingLock.has(telegramId)) {
    console.log(`[Batch] Processing already locked for user ${telegramId}`);
    return;
  }
  const queueSize = photoQueue.get(telegramId)?.length || 0;
  if (queueSize === 0) {
    console.log(`[Batch] Empty queue for user ${telegramId}`);
    return;
  }
  processingLock.add(telegramId);
  await ctx.reply(`✅ Принято ${queueSize} фото. Начинаю обработку... Это может занять некоторое время.`);
  if (ctx.session) {
    ctx.session.batchUnrecognizedItems = [];
    ctx.session.batchNewlyAddedCount = 0;
    sessions.set(ctx.chat!.id.toString(), ctx.session);
  }
  await processPhotoQueue(ctx);
}

bot.on('photo', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('❌ Не удалось определить ваш ID. Нажмите /start, чтобы начать.');
    return;
  }
  if (processingLock.has(telegramId)) {
    await ctx.reply('⏳ Пожалуйста, подождите. Идет обработка предыдущей пачки скриншотов.');
    return;
  }
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии. Нажмите /start, чтобы начать.');
    return;
  }
  if (ctx.session.waitingForExcel) {
    await ctx.reply('❌ Сначала отправьте Excel файл, прежде чем добавлять скриншоты.');
    return;
  }
  const session = await storage.getSession(ctx.session.sessionId);
  if (!session) {
    await ctx.reply('❌ Сессия не найдена в базе данных');
    cleanupSession(ctx);
    return;
  }
  if (session.expiresAt && new Date() > session.expiresAt) {
    await ctx.reply('⏰ Время сессии истекло. Завершаю...');
    await completeSession(ctx);
    return;
  }
  const currentQueueSize = photoQueue.get(telegramId)?.length || 0;
  const processedCount = ctx.session.screenshotCount || 0;
  const totalPhotos = processedCount + currentQueueSize + 1;
  if (session.photoLimit > 0 && totalPhotos > session.photoLimit) {
    await ctx.reply(
      `🚫 Достигнут лимит ${session.photoLimit} скриншотов.\n` +
      `(Обработано: ${processedCount}, в очереди: ${currentQueueSize})`
    );
    await completeSession(ctx);
    return;
  }
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  if (!photoQueue.has(telegramId)) {
    photoQueue.set(telegramId, []);
  }
  photoQueue.get(telegramId)!.push(fileId);
  console.log(`[Photo] Added photo to queue for user ${telegramId}, queue size: ${photoQueue.get(telegramId)!.length}`);
  if (userDebounceTimers.has(telegramId)) {
    clearTimeout(userDebounceTimers.get(telegramId)!);
  }
  // Создаем копию контекста для таймера
  const ctxCopy = {
    ...ctx,
    session: { ...ctx.session },
    from: { ...ctx.from },
    chat: { ...ctx.chat },
    reply: ctx.reply.bind(ctx),
    telegram: ctx.telegram
  };
  const timer = setTimeout(() => {
    startBatchProcessing(ctxCopy);
    userDebounceTimers.delete(telegramId);
  }, DEBOUNCE_TIMEOUT_MS);
  userDebounceTimers.set(telegramId, timer);
});

bot.on('document', async (ctx) => {
  if (!ctx.session?.sessionId || !ctx.session.waitingForExcel) {
    await ctx.reply('❌ Сначала выберите режим работы командой /start');
    return;
  }
  const session = await storage.getSession(ctx.session.sessionId);
  if (!session) {
    await ctx.reply('❌ Сессия не найдена в базе данных');
    cleanupSession(ctx);
    return;
  }
  if (session.type === 'price_update') {
    await handlePriceUpdateDocument(ctx);
    return;
  }
  if (session.type === 'split_excel') {
    await handleSplitExcelDocument(ctx);
    return;
  }
  const document = ctx.message.document;
  const fileName = document.file_name || '';
  if (!fileName.match(/.(xlsx?|xls)$/i)) {
    await ctx.reply('❌ Поддерживаются только Excel файлы (.xlsx, .xls)');
    return;
  }
  try {
    await ctx.reply('📄 Загружаю Excel файл...');
    const fileInfo = await ctx.telegram.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const excelItems = await parseExcelBuffer(buffer);
    if (excelItems.length === 0) {
      await ctx.reply('❌ Excel файл не содержит данных или имеет неправильный формат');
      return;
    }
    const inventoryItems: InsertInventoryItem[] = [];
    await ctx.reply(`🔄 Обогащаю данные из Warframe Market...`);
    for (const item of excelItems) {
      let marketItem = null;
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

async function handlePriceUpdateDocument(ctx: BotContext) {
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии');
    return;
  }
  const document = (ctx.message as any)?.document;
  const fileName = document?.file_name || '';
  if (!fileName.match(/.(xlsx?|xls)$/i)) {
    await ctx.reply('❌ Поддерживаются только Excel файлы (.xlsx, .xls)');
    return;
  }
  try {
    await ctx.reply('📄 Загружаю Excel файл...');
    const fileInfo = await ctx.telegram.getFile(document!.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const excelItems = await parseExcelBuffer(buffer);
    if (excelItems.length === 0) {
      await ctx.reply('❌ Excel файл не содержит данных или имеет неправильный формат');
      return;
    }
    await ctx.reply(`🔄 Обновляю цены для ${excelItems.length} предметов...`);
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
    await storage.createInventoryItems(inventoryItems);
    await completeSession(ctx);
  } catch (error) {
    console.error('Error updating prices:', error);
    await ctx.reply('❌ Ошибка при обновлении цен. Проверьте формат Excel файла.');
  }
}

async function handleSplitExcelDocument(ctx: BotContext) {
  if (!ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии');
    return;
  }
  const document = (ctx.message as any)?.document;
  const fileName = document?.file_name || '';
  if (!fileName.match(/.(xlsx?|xls)$/i)) {
    await ctx.reply('❌ Поддерживаются только Excel файлы (.xlsx, .xls)');
    return;
  }
  try {
    await ctx.reply('📄 Загружаю Excel файл...');
    const fileInfo = await ctx.telegram.getFile(document!.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const excelItems = await parseExcelBuffer(buffer);
    if (excelItems.length === 0) {
      await ctx.reply('❌ Excel файл не содержит данных или имеет неправильный формат');
      return;
    }
    const inventoryItems: InsertInventoryItem[] = [];
    await ctx.reply(`🔄 Обогащаю данные из Warframe Market...`);
    for (const item of excelItems) {
      let marketItem = null;
      try {
        marketItem = await processItemForMarket(item.name);
      } catch (error) {
        console.warn(`Could not find market data for Excel item: ${item.name}`);
      }
      const sellPrices = marketItem?.sellPrices?.slice(0, 5) || [];
      inventoryItems.push({
        sessionId: ctx.session!.sessionId!,
        name: item.name,
        slug: marketItem?.slug || null,
        quantity: item.quantity,
        sellPrices: sellPrices,
        buyPrices: marketItem?.buyPrices || [],
        avgSell: marketItem?.avgSell ? Math.round(marketItem.avgSell * 100) : 0,
        avgBuy: marketItem?.avgBuy ? Math.round(marketItem.avgBuy * 100) : 0,
        marketUrl: marketItem?.marketUrl || null,
        source: 'excel' as const
      });
    }
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
      const first5Prices = sellPrices.slice(0, 5);
      const pricesAboveThreshold = first5Prices.filter(price => price >= threshold);
      if (pricesAboveThreshold.length >= 3) {
        highPriceItems.push(item);
      } else {
        lowPriceItems.push(item);
      }
    }
    const highPriceBuffer = await generateExcelBuffer(highPriceItems);
    const lowPriceBuffer = await generateExcelBuffer(lowPriceItems);
    await storage.updateSessionStatus(sessionId, 'completed');
    ctx.session = {};
    sessions.set(ctx.chat!.id.toString(), ctx.session);
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

bot.on('text', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId || !ctx.session?.sessionId) {
    await ctx.reply('❌ Нет активной сессии. Нажмите /start, чтобы начать.');
    return;
  }
  const session = await storage.getSession(ctx.session.sessionId);
  if (!session || session.status !== 'active') {
    ctx.session = {};
    sessions.set(ctx.chat!.id.toString(), ctx.session);
    await ctx.reply('❌ Сессия завершена или не найдена. Нажмите /start, чтобы начать новую.');
    return;
  }
  if (ctx.session?.waitingForSplitPrice) {
    const priceText = ctx.message.text.trim();
    const price = parseFloat(priceText);
    if (isNaN(price) || price <= 0) {
      await ctx.reply('❌ Введите корректное число больше 0.');
      return;
    }
    ctx.session.splitThreshold = price;
    ctx.session.waitingForSplitPrice = false;
    sessions.set(ctx.chat!.id.toString(), ctx.session);
    await handleExcelSplit(ctx);
    return;
  }
  if (!ctx.session?.sessionId || (ctx.session.mode !== 'multishot' && ctx.session.mode !== 'edit')) {
    if (!ctx.message.text.startsWith('/')) {
      await ctx.reply('💡 Чтобы добавить предметы текстом, начните сессию "Многоразовый анализ" или "Редактирование Excel".');
    }
    return;
  }
  try {
    const loadingMessage = await ctx.reply('🔄 Обрабатываю ваш текст...');
    const itemsFromText = parseTextToItems(ctx.message.text);
    if (itemsFromText.length === 0) {
      await ctx.deleteMessage(loadingMessage.message_id);
      await ctx.reply(
        'Не найдено предметов для добавления в вашем сообщении.\n' +
        '💡 Отправьте текст в формате: Название|Количество, например:\n' +
        'Висп Прайм: Каркас|2\nСевагот Прайм: Система|1'
      );
      return;
    }
    await processRawItems(ctx, itemsFromText);
    await ctx.deleteMessage(loadingMessage.message_id);
  } catch (error) {
    console.error('Error processing text input:', error);
    await ctx.reply('❌ Ошибка при обработке вашего текста.');
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Произошла ошибка. Попробуйте еще раз или обратитесь к администратору.');
});

export { bot };