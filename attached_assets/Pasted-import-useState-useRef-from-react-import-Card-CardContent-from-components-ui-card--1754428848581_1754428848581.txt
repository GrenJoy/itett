import { useState, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CloudUpload, Images, X } from "lucide-react";

interface FileUploadProps {
  mode: 'oneshot' | 'online';
  onJobCreated: (jobId: string) => void;
  onProcessingComplete: () => void;
}

export function FileUpload({ mode, onJobCreated, onProcessingComplete }: FileUploadProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    
    const imageFiles = Array.from(files).filter(file => 
      file.type.startsWith('image/')
    );
    
    if (imageFiles.length === 0) {
      toast({
        title: "Invalid files",
        description: "Please select only image files",
        variant: "destructive",
      });
      return;
    }
    
    setSelectedFiles(prev => [...prev, ...imageFiles]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add('border-blue-500');
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-blue-500');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-blue-500');
    handleFileSelect(e.dataTransfer.files);
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processFiles = async () => {
    if (selectedFiles.length === 0) return;

    setUploading(true);
    try {
      const formData = new FormData();
      selectedFiles.forEach(file => {
        formData.append('images', file);
      });

      const endpoint = mode === 'oneshot' ? '/api/process-oneshot' : '/api/process-online';
      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      onJobCreated(data.jobId);
      setSelectedFiles([]);
      
      toast({
        title: "Processing started",
        description: `Processing ${selectedFiles.length} images...`,
      });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: "Failed to upload and process images",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardContent className="p-6">
        <div className="flex items-center mb-4">
          <CloudUpload className="text-blue-500 mr-3 text-xl" />
          <h2 className="text-xl font-semibold text-white">
            {mode === 'oneshot' ? 'Одноразовая обработка' : 'Онлайн-редактирование'}
          </h2>
        </div>
        
        {/* Drop Zone */}
        <div
          className="border-2 border-dashed border-gray-600 rounded-lg p-8 text-center hover:border-blue-500 transition-colors duration-200 cursor-pointer"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <Images className="mx-auto text-4xl text-gray-400 mb-4" />
          <p className="text-lg text-gray-300 mb-2">Перетащите файлы сюда</p>
          <p className="text-sm text-gray-400 mb-4">или нажмите для выбора</p>
          <Button className="bg-blue-600 hover:bg-blue-700">
            Выбрать файлы
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files)}
          />
        </div>

        {/* File List */}
        {selectedFiles.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-medium text-gray-300">Выбранные файлы:</h3>
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className="flex items-center justify-between bg-gray-700 rounded-lg p-3"
              >
                <div className="flex items-center">
                  <Images className="text-blue-500 mr-3 h-4 w-4" />
                  <span className="text-sm text-gray-300">{file.name}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeFile(index)}
                  className="text-red-400 hover:text-red-300"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Button
          onClick={processFiles}
          disabled={selectedFiles.length === 0 || uploading}
          className="w-full mt-4 bg-green-600 hover:bg-green-700 disabled:bg-gray-600"
        >
          {uploading ? "Обрабатываем..." : "Обработать скриншоты"}
        </Button>
      </CardContent>
    </Card>
  );
}
