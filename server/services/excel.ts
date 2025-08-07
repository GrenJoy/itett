import ExcelJS from 'exceljs';
import { type InventoryItem } from '@shared/schema';

export interface ExcelItem {
  name: string;
  quantity: number;
  sellPrices?: number[] | string;
  buyPrices?: number[] | string;
  avgSell?: number;
  avgBuy?: number;
  marketUrl?: string;
}

export async function generateExcelBuffer(items: InventoryItem[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Warframe Inventory');

  // Headers matching the screenshot format
  worksheet.columns = [
    { header: 'Название предмета', key: 'name', width: 35 },
    { header: 'Количество', key: 'quantity', width: 12 },
    { header: 'Цена продажи', key: 'sellPrices', width: 25 },
    { header: 'Цена покупки', key: 'buyPrices', width: 25 },
    { header: 'Средняя цена продажи', key: 'avgSell', width: 20 },
    { header: 'Ссылка', key: 'marketUrl', width: 80 }
  ];

  // Style headers
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Add data
  items.forEach((item) => {
    const sellPricesStr = Array.isArray(item.sellPrices) && item.sellPrices.length > 0 
      ? item.sellPrices.join(', ') 
      : '';
    
    const buyPricesStr = Array.isArray(item.buyPrices) && item.buyPrices.length > 0 
      ? item.buyPrices.join(', ') 
      : '';

    worksheet.addRow({
      name: item.name,
      quantity: item.quantity,
      sellPrices: sellPricesStr,
      buyPrices: buyPricesStr,
      avgSell: item.avgSell ? item.avgSell / 100 : 0, // Convert back from stored precision
      marketUrl: item.marketUrl || ''
    });
  });

  // Auto-fit columns
  worksheet.columns.forEach(column => {
    if (column.key !== 'marketUrl') {
      let maxLength = 0;
      column.eachCell?.({ includeEmpty: true }, (cell) => {
        const columnLength = cell.value ? cell.value.toString().length : 10;
        if (columnLength > maxLength) {
          maxLength = columnLength;
        }
      });
      column.width = Math.min(maxLength + 2, 50);
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function parseExcelBuffer(buffer: Buffer): Promise<ExcelItem[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('No worksheet found in Excel file');
  }

  const items: ExcelItem[] = [];
  
  // Skip header row (row 1)
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header
    
    const values = row.values as any[];
    
    // Extract values by position (1-indexed, 0 is empty) - updated for new column structure
    const name = values[1]?.toString()?.trim();
    // FIXED: Properly handle quantity - only default to 1 if truly empty/invalid
    const quantityValue = values[2]?.toString()?.trim();
    const quantity = quantityValue && !isNaN(parseInt(quantityValue)) ? parseInt(quantityValue) : 1;
    const sellPricesStr = values[3]?.toString()?.trim() || '';
    const buyPricesStr = values[4]?.toString()?.trim() || '';
    
    // Parse sell prices into array of numbers
    const sellPrices = sellPricesStr ? sellPricesStr.split(/[,;]/).map((p: string) => parseFloat(p.trim())).filter((p: number) => !isNaN(p)) : [];
    const buyPrices = buyPricesStr ? buyPricesStr.split(/[,;]/).map((p: string) => parseFloat(p.trim())).filter((p: number) => !isNaN(p)) : [];
    const avgSell = Math.round((parseFloat(values[5]?.toString()) || 0) * 100); // Convert to int (platinum * 100)
    const marketUrl = values[6]?.toString()?.trim() || '';
    
    if (name) {
      items.push({
        name,
        quantity,
        sellPrices,
        buyPrices,
        avgSell,
        avgBuy: 0, // Not used in new format
        marketUrl
      });
    }
  });

  return items;
}
