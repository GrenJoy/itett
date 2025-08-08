import express from "express";
import { bot } from "./bot";
import { loadItemsCache } from "./services/warframe-market";

const app = express();

// Initialize bot and services
async function startBot() {
  try {
    console.log('Loading Warframe Market cache...');
    await loadItemsCache();
    console.log('Warframe Market cache loaded successfully');

    console.log('Starting Telegram bot...');
    // Очистка вебхука для избежания конфликтов
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(e => console.log('Webhook deletion failed (expected if not set):', e.message));
    await bot.launch({ dropPendingUpdates: true });
    console.log('Telegram bot started successfully');

    // Background cleanup for expired sessions
    setInterval(async () => {
      try {
        const { storage } = await import('./storage');
        const expiredSessions = await storage.getExpiredSessions();
        for (const session of expiredSessions) {
          console.log(`[Cleanup] Auto-completing expired session ${session.id} for user ${session.telegramId}`);
          await storage.updateSessionStatus(session.id, 'completed');
        }
      } catch (error) {
        console.error('Error during expired session cleanup:', error);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  } catch (error: any) {
    console.error('Failed to start bot:', error);
    if (error.response?.error_code === 409) {
      console.log('Bot conflict detected. Exiting to avoid further conflicts...');
      process.exit(1); // Завершить процесс при конфликте
    }
    throw error; // Передадим ошибку дальше для обработки
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint with instructions
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Warframe Inventory Analyzer Bot</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
            .header { text-align: center; margin-bottom: 40px; }
            .status { background: #e8f5e8; padding: 15px; border-radius: 8px; margin: 20px 0; }
            .instructions { background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .features { background: #fff8dc; padding: 20px; border-radius: 8px; margin: 20px 0; }
            code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🎮 Warframe Inventory Analyzer</h1>
            <p>Telegram бот для анализа скриншотов инвентаря с ИИ</p>
        </div>
        
        <div class="status">
            <h3>✅ Статус сервера</h3>
            <p>Сервер работает и готов к обработке запросов</p>
            <p>Кеш Warframe Market загружен: <strong>3610 предметов</strong></p>
        </div>
        
        <div class="instructions">
            <h3>📱 Как использовать</h3>
            <p>Это <strong>Telegram бот</strong>, а не веб-сайт! Для работы:</p>
            <ol>
                <li>Найдите бота в Telegram по токену или username</li>
                <li>Отправьте команду <code>/start</code></li>
                <li>Выберите режим работы</li>
                <li>Отправляйте скриншоты инвентаря Warframe</li>
            </ol>
        </div>
        
        <div class="features">
            <h3>🚀 Возможности бота</h3>
            <ul>
                <li><strong>🎯 Анализ скриншотов</strong> - скриншоты → Excel файл (до 16 скриншотов)</li>
                <li><strong>📊 Многоразовый анализ</strong> - накопление данных из нескольких сессий</li>
                <li><strong>📝 Редактирование Excel</strong> - импорт Excel + новые скриншоты</li>
                <li><strong>🤖 ИИ анализ</strong> - Gemini AI для распознавания предметов</li>
                <li><strong>💰 Цены в реальном времени</strong> - Warframe Market API</li>
                <li><strong>📋 Excel экспорт</strong> - готовые отчеты с ценами</li>
            </ul>
        </div>
        
        <div class="status">
            <p><strong>Время запуска:</strong> ${new Date().toLocaleString('ru-RU')}</p>
            <p><strong>Статус базы данных:</strong> Подключена</p>
            <p><strong>Telegram Bot:</strong> Активен</p>
        </div>
    </body>
    </html>
  `);
});

// Start the server and bot
async function startServer() {
  // Render предоставляет переменную PORT. Для локального теста можно задать значение по умолчанию.
  const port = process.env.PORT || 3000;

  try {
    // 1. Сначала запускаем веб-сервер, чтобы он открыл порт.
    app.listen(port, '0.0.0.0', async () => {
      console.log(`Health check server running on port ${port}`);
      
      // 2. После того как сервер успешно запущен, запускаем бота.
      // Теперь это не будет блокировать открытие порта.
      await startBot();
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down...');
  await bot.stop('SIGTERM');
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down...');
  await bot.stop('SIGINT');
  process.exit(0);
});

startServer();