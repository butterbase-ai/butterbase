import { useState, type FormEvent } from 'react';
import { ImageUpload } from './ImageUpload';
import { uploadImage } from '../services/storage';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { CreateGroceryItemInput } from '../types';

interface GroceryFormProps {
  onItemCreated: () => void;
}

export function GroceryForm({ onItemCreated }: GroceryFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { token } = useAuth();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;

    setError('');
    setLoading(true);

    try {
      let imageUrl: string | undefined;

      if (imageFile) {
        const uploadResult = await uploadImage(imageFile, token);
        imageUrl = uploadResult.objectId;
      }

      const body: CreateGroceryItemInput = {
        title,
        description: description || undefined,
        image_url: imageUrl,
      };

      butterbase.setAccessToken(token);
      const { error } = await butterbase.from('grocery_items').insert(body).execute();

      if (error) {
        throw error;
      }

      setTitle('');
      setDescription('');
      setImageFile(null);
      onItemCreated();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to add item';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{ marginBottom: '30px', padding: '20px', border: '1px solid #ccc' }}
    >
      <h2>Add item</h2>
      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="title" style={{ display: 'block', marginBottom: '5px' }}>
          Item name *
        </label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          style={{ width: '100%', padding: '8px' }}
        />
      </div>
      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="description" style={{ display: 'block', marginBottom: '5px' }}>
          Notes (brand, quantity, aisle…)
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          style={{ width: '100%', padding: '8px' }}
        />
      </div>
      <ImageUpload onImageSelected={setImageFile} />
      {error && (
        <div style={{ color: 'red', marginBottom: '15px' }}>{error}</div>
      )}
      <button
        type="submit"
        disabled={loading}
        style={{ padding: '10px 20px', cursor: loading ? 'not-allowed' : 'pointer' }}
      >
        {loading ? 'Adding…' : 'Add to list'}
      </button>
    </form>
  );
}
