

const WFM_BASE_URL = "https://api.warframe.market/v2";
const HEADERS = { 'Platform': 'pc', 'Language': 'ru' };

async function fetchAndSaveItems() {
  console.log("Запускаю скрипт для получения списка всех предметов с Warframe Market...");
  
  try {
    const response = await fetch(`${WFM_BASE_URL}/items`, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    const items = data.data || [];
    
    // Создаем папку 'data', если ее нет
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir);
    }
    
    // Сохраняем данные в файл
    const filePath = path.join(dataDir, 'items.json');
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2));
    
    console.log(`✅ Успешно! Список из ${items.length} предметов сохранен в файл: ${filePath}`);
    
  } catch (error) {
    console.error('❌ Ошибка при получении или сохранении списка предметов:', error);
  }
}

fetchAndSaveItems();