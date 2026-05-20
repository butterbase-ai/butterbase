import { useState, type FormEvent } from 'react';
import { ImageUpload } from './ImageUpload';
import { uploadImage } from '../services/storage';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { CreateTodoInput } from '../types';

interface TodoFormProps {
  onTodoCreated: () => void;
}

export function TodoForm({ onTodoCreated }: TodoFormProps) {
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

      const todoData: CreateTodoInput = {
        title,
        description: description || undefined,
        image_url: imageUrl,
      };

      butterbase.setAccessToken(token);
      const { error } = await butterbase.from('todos').insert(todoData).execute();

      if (error) {
        throw error;
      }

      setTitle('');
      setDescription('');
      setImageFile(null);
      onTodoCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create todo');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: '30px', padding: '20px', border: '1px solid #ccc' }}>
      <h2>Create New Todo</h2>
      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="title" style={{ display: 'block', marginBottom: '5px' }}>
          Title *
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
          Description
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
        {loading ? 'Creating...' : 'Create Todo'}
      </button>
    </form>
  );
}
