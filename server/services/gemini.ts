import { GoogleGenAI } from "@google/genai";
import pLimit from "p-limit";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || "" });
const geminiLimit = pLimit(3); // Limit to 3 concurrent Gemini requests

export interface ExtractedItem {
  name: string;
  quantity: number;
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>, 
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Check if it's a rate limit error (429) or temporary error
      if (error.message?.includes('429') || error.message?.includes('quota') || error.message?.includes('rate limit')) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.warn(`Rate limit hit, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached');
}

export async function analyzeWarframeScreenshot(base64Image: string): Promise<ExtractedItem[]> {
  return geminiLimit(async () => {
    return retryWithBackoff(async () => {
      try {
    const prompt = `Твоя задача - точно скопировать названия предметов из списка на скриншоте из игры Warframe И УКАЗАТЬ их количество.

ПРАВИЛА:
1. Выписывай каждый предмет НА ОТДЕЛЬНОЙ СТРОКЕ в формате "Название предмета|Количество".
2. Если строка начинается со слова "ЧЕРТЁЖ:", ОБЯЗАТЕЛЬНО в ответе удали слово "ЧЕРТЕЖ:" в начале, но добавь "(Чертеж)" в конце.
3. КОЛИЧЕСТВО берешь из числа в кружочке в левом верхнем углу каждого предмета (например x2, x6, x3).
4. Если количество НЕ ВИДНО или отсутствует, ставь "1".
5. НЕ добавляй ничего от себя. Только название и количество через "|".

ВАЖНО - ОБРАБОТКА ДУБЛИКАТОВ:
6. Если ОДИН И ТОТ ЖЕ предмет повторяется несколько раз в списке, НЕ дублируй его!
7. Вместо этого СУММИРУЙ количество и выпиши предмет ТОЛЬКО ОДИН РАЗ.
8. Пример: Если видишь "Висп Прайм: Каркас" два раза, пиши "Висп Прайм: Каркас|2".

Отвечай в формате JSON массива объектов с полями "name" и "quantity".

ПРИМЕР ОЖИДАЕМОГО ВЫВОДА:
[
  {"name": "Наутилус Прайм: Панцирь", "quantity": 1},
  {"name": "Наутилус Прайм: Система", "quantity": 2},
  {"name": "Севагот Прайм: Система (Чертеж)", "quantity": 6},
  {"name": "Висп Прайм: Каркас", "quantity": 2}
]`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number" }
            },
            required: ["name", "quantity"]
          }
        }
      },
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        prompt
      ],
    });

    const rawJson = response.text;
    
    if (!rawJson) {
      throw new Error("Empty response from Gemini");
    }

    const extractedItems: ExtractedItem[] = JSON.parse(rawJson);
    
    if (!Array.isArray(extractedItems)) {
      throw new Error("Response is not an array");
    }

    return extractedItems.map(item => ({
      name: item.name || "",
      quantity: Math.max(1, item.quantity || 1)
    }));

      } catch (error) {
        console.error('Failed to analyze screenshot:', error);
        throw new Error(`Failed to analyze Warframe screenshot: ${error}`);
      }
    });
  });
}
