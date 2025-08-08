import json
import os
import requests # Возможно, понадобится установить: pip install requests

# Константы, как в вашем коде
WFM_BASE_URL = "https://api.warframe.market/v2"
HEADERS = {
    'Platform': 'pc',
    'Language': 'ru',
    'User-Agent': 'Warframe-Inventory-Fetcher/Python-v1'
}

def fetch_and_save_items():
    """
    Скачивает список всех предметов с Warframe Market
    и сохраняет его в файл data/items.json
    """
    print("Запускаю скрипт для получения списка всех предметов с Warframe Market...")
    
    try:
        # 1. Делаем запрос к API
        response = requests.get(f"{WFM_BASE_URL}/items", headers=HEADERS)
        response.raise_for_status()  # Вызовет ошибку, если статус не 200 OK
        
        data = response.json()
        items = data.get("data", [])
        
        # 2. Создаем папку 'data', если ее нет
        data_dir = os.path.join(os.getcwd(), 'data')
        if not os.path.exists(data_dir):
            os.makedirs(data_dir)
        
        # 3. Сохраняем данные в файл
        file_path = os.path.join(data_dir, 'items.json')
        
        with open(file_path, 'w', encoding='utf-8') as f:
            # indent=2 для красивого форматирования, ensure_ascii=False для кириллицы
            json.dump(items, f, indent=2, ensure_ascii=False)
            
        print(f"✅ Успешно! Список из {len(items)} предметов сохранен в файл: {file_path}")

    except requests.exceptions.RequestException as e:
        print(f"❌ Ошибка сети при запросе к API: {e}")
    except Exception as e:
        print(f"❌ Произошла непредвиденная ошибка: {e}")


# Запускаем нашу функцию
if __name__ == "__main__":
    fetch_and_save_items()