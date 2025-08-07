import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FileSpreadsheet, Upload, X, Split, Download } from "lucide-react";
import * as XLSX from "xlsx";

interface ExcelSplitProps {
  onJobCreated?: (jobId: string) => void;
  onProcessingComplete?: () => void;
}

export function ExcelSplit({ onJobCreated, onProcessingComplete }: ExcelSplitProps) {
  const [selectedExcelFile, setSelectedExcelFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [threshold, setThreshold] = useState(11);
  const [splitResults, setSplitResults] = useState<{
    lowPriceData: any[];
    highPriceData: any[];
    lowCount: number;
    highCount: number;
  } | null>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleExcelSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xls')) {
      toast({
        title: "Неверный формат файла",
        description: "Пожалуйста, выберите Excel файл (.xlsx или .xls)",
        variant: "destructive",
      });
      return;
    }

    setSelectedExcelFile(file);
    setSplitResults(null);
  };

  const removeExcelFile = () => {
    setSelectedExcelFile(null);
    setSplitResults(null);
  };

  const splitExcel = async () => {
    if (!selectedExcelFile) {
      toast({
        title: "Файл не выбран",
        description: "Выберите Excel файл для разделения",
        variant: "destructive",
      });
      return;
    }

    setProcessing(true);
    try {
      const arrayBuffer = await selectedExcelFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);

      const lowPriceData: any[] = [];
      const highPriceData: any[] = [];

      data.forEach((row: any) => {
        const pricesStr = row['Цена продажи'] || '';
        const prices = pricesStr.split(',').map((p: string) => parseFloat(p.trim()) || 0).filter((p: number) => !isNaN(p));

        if (prices.length === 0) {
          lowPriceData.push(row); // Если нет цен, в низкие
          return;
        }

        const lowCount = prices.filter((p: number) => p < threshold).length;
        const highCount = prices.filter((p: number) => p >= threshold).length;

        // Большинство цен определяет файл
        if (highCount > lowCount) {
          highPriceData.push(row);
        } else {
          lowPriceData.push(row);
        }
      });

      setSplitResults({
        lowPriceData,
        highPriceData,
        lowCount: lowPriceData.length,
        highCount: highPriceData.length,
      });

      if (onJobCreated) onJobCreated(Date.now().toString());
      if (onProcessingComplete) onProcessingComplete();

      toast({
        title: "Разделение завершено",
        description: `Файл разделен: ${lowPriceData.length} предметов до ${threshold-1} платины, ${highPriceData.length} предметов от ${threshold} платины`,
      });
    } catch (error) {
      console.error(error);
      toast({
        title: "Ошибка разделения",
        description: "Не удалось разделить Excel файл",
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
    }
  };

  const downloadFile = (fileType: 'low' | 'high') => {
    if (!splitResults) return;

    try {
      const data = fileType === 'low' ? splitResults.lowPriceData : splitResults.highPriceData;
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, worksheet, fileType === 'low' ? 'Low Price' : 'High Price');

      XLSX.writeFile(workbook, fileType === 'low' ? 'warframe_inventory_low_price.xlsx' : 'warframe_inventory_high_price.xlsx');

      toast({
        title: "Файл скачан",
        description: `${fileType === 'low' ? 'Низкие цены' : 'Высокие цены'} файл успешно скачан`,
      });
    } catch (error) {
      console.error(error);
      toast({
        title: "Ошибка скачивания",
        description: "Не удалось создать или скачать файл",
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="flex items-center text-white">
          <Split className="text-teal-500 mr-3 text-xl" />
          Разделение по цене
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-300">Порог разделения (платина)</h3>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value) || 11)}
                min="1"
                max="100"
                className="w-16 px-2 py-1 text-sm bg-gray-700 border border-gray-600 rounded text-white"
                disabled={processing}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => excelInputRef.current?.click()}
                className="border-gray-600 hover:bg-gray-700"
                disabled={processing}
              >
                <Upload className="mr-2 h-4 w-4" />
                Выбрать Excel
              </Button>
            </div>
          </div>

          {selectedExcelFile ? (
            <div className="flex items-center justify-between bg-gray-700 rounded-lg p-3">
              <div className="flex items-center">
                <FileSpreadsheet className="text-teal-500 mr-3 h-4 w-4" />
                <span className="text-sm text-gray-300">{selectedExcelFile.name}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={removeExcelFile}
                className="text-red-400 hover:text-red-300"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="border-2 border-dashed border-gray-600 rounded-lg p-4 text-center">
              <p className="text-sm text-gray-400">Excel файл не выбран</p>
            </div>
          )}

          <input
            ref={excelInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => handleExcelSelect(e.target.files)}
          />
        </div>

        <Button
          onClick={splitExcel}
          disabled={!selectedExcelFile || processing}
          className="w-full bg-teal-600 hover:bg-teal-700 disabled:bg-gray-600"
        >
          {processing ? "Разделяем файл..." : "Разделить по цене"}
        </Button>

        {splitResults && (
          <div className="space-y-3 border-t border-gray-600 pt-4">
            <h4 className="text-sm font-medium text-gray-300">Результаты разделения:</h4>

            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => downloadFile('low')}
                variant="outline"
                className="flex items-center justify-center bg-green-900/20 border-green-600 text-green-400 hover:bg-green-900/30"
              >
                <Download className="mr-2 h-4 w-4" />
                До {threshold-1} платины
                <span className="ml-1 text-xs">({splitResults.lowCount})</span>
              </Button>

              <Button
                onClick={() => downloadFile('high')}
                variant="outline"
                className="flex items-center justify-center bg-red-900/20 border-red-600 text-red-400 hover:bg-red-900/30"
              >
                <Download className="mr-2 h-4 w-4" />
                От {threshold} платины
                <span className="ml-1 text-xs">({splitResults.highCount})</span>
              </Button>
            </div>
          </div>
        )}

        <div className="text-xs text-gray-400 bg-gray-700 rounded-lg p-3">
          <p className="font-medium mb-1">Как это работает:</p>
          <ul className="space-y-1 text-gray-400">
            <li>• Установите порог разделения (по умолчанию 11 платины)</li>
            <li>• Загрузите Excel файл с ценами</li>
            <li>• Система проверит большинство цен у каждого предмета</li>
            <li>• Если больше цен больше или равно порогу → в high_price файл</li>
            <li>• Если больше цен меньше порога → в low_price файл</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}