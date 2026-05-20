import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { Todo } from '../types';

interface TodoItemProps {
  todo: Todo;
  onTodoUpdated: () => void;
  onTodoDeleted: () => void;
}

export function TodoItem({ todo, onTodoUpdated, onTodoDeleted }: TodoItemProps) {
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const { token } = useAuth();

  const handleToggleComplete = async () => {
    if (!token) return;
    setLoading(true);

    try {
      butterbase.setAccessToken(token);
      const { error } = await butterbase
        .from('todos')
        .update({ completed: !todo.completed })
        .eq('id', todo.id)
        .execute();

      if (error) {
        throw error;
      }

      onTodoUpdated();
    } catch (err) {
      alert('Failed to update todo');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!token || !confirm('Are you sure you want to delete this todo?')) return;
    setLoading(true);

    try {
      butterbase.setAccessToken(token);
      const { error } = await butterbase
        .from('todos')
        .delete()
        .eq('id', todo.id)
        .execute();

      if (error) {
        throw error;
      }

      onTodoDeleted();
    } catch (err) {
      alert('Failed to delete todo');
    } finally {
      setLoading(false);
    }
  };

  const loadImage = async () => {
    if (!todo.image_url || !token || imageUrl) return;

    try {
      butterbase.setAccessToken(token);
      const { data, error } = await butterbase.storage.getDownloadUrl(todo.image_url);

      if (!error && data) {
        setImageUrl(data.url);
      }
    } catch (err) {
      console.error('Failed to load image', err);
    }
  };

  if (todo.image_url && !imageUrl) {
    loadImage();
  }

  return (
    <div style={{
      padding: '15px',
      border: '1px solid #ddd',
      marginBottom: '10px',
      backgroundColor: todo.completed ? '#f0f0f0' : 'white'
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={handleToggleComplete}
          disabled={loading}
          style={{ marginTop: '5px' }}
        />
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 5px 0', textDecoration: todo.completed ? 'line-through' : 'none' }}>
            {todo.title}
          </h3>
          {todo.description && (
            <p style={{ margin: '0 0 10px 0', color: '#666' }}>{todo.description}</p>
          )}
          {imageUrl && (
            <img
              src={imageUrl}
              alt={todo.title}
              style={{ maxWidth: '200px', maxHeight: '200px', display: 'block', marginTop: '10px' }}
            />
          )}
          <div style={{ fontSize: '12px', color: '#999', marginTop: '10px' }}>
            Created: {new Date(todo.created_at).toLocaleString()}
          </div>
        </div>
        <button
          onClick={handleDelete}
          disabled={loading}
          style={{
            padding: '5px 10px',
            backgroundColor: '#dc3545',
            color: 'white',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
