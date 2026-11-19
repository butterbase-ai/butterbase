import { useLocale, text } from '../i18n';
import { useState, type ChangeEvent } from 'react';

interface ImageUploadProps {
  onImageSelected: (file: File | null) => void;
  currentImageUrl?: string | null;
}

export function ImageUpload({ onImageSelected, currentImageUrl }: ImageUploadProps) {
  useLocale();
  const [preview, setPreview] = useState<string | null>(currentImageUrl || null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        alert(text("File size must be less than 10MB"));
        return;
      }
      if (!file.type.startsWith('image/')) {
        alert(text("File must be an image"));
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
      onImageSelected(file);
    } else {
      setPreview(null);
      onImageSelected(null);
    }
  };

  const handleClear = () => {
    setPreview(null);
    onImageSelected(null);
  };

  return (
    <div style={{ marginBottom: '15px' }}>
      <label htmlFor="image" style={{ display: 'block', marginBottom: '5px' }}>{text("Image (optional)")}</label>
      <input
        id="image"
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ marginBottom: '10px' }}
      />
      {preview && (
        <div>
          <img
            src={preview}
            alt={text("Preview")}
            style={{ maxWidth: '200px', maxHeight: '200px', display: 'block', marginBottom: '10px' }}
          />
          <button type="button" onClick={handleClear} style={{ padding: '5px 10px' }}>{text("Clear Image")}</button>
        </div>
      )}
    </div>
  );
}
