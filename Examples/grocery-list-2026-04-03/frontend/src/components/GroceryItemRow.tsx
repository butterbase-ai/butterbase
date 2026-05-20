import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { GroceryItem } from '../types';

interface GroceryItemRowProps {
  item: GroceryItem;
  onItemUpdated: () => void;
  onItemDeleted: () => void;
}

export function GroceryItemRow({ item, onItemUpdated, onItemDeleted }: GroceryItemRowProps) {
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const { token } = useAuth();

  const handleToggleGotIt = async () => {
    if (!token) return;
    setLoading(true);

    try {
      butterbase.setAccessToken(token);
      const { error } = await butterbase
        .from('grocery_items')
        .update({ completed: !item.completed })
        .eq('id', item.id)
        .execute();

      if (error) {
        throw error;
      }

      onItemUpdated();
    } catch {
      alert('Failed to update item');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!token || !confirm('Remove this item from your list?')) return;
    setLoading(true);

    try {
      butterbase.setAccessToken(token);
      const { error } = await butterbase
        .from('grocery_items')
        .delete()
        .eq('id', item.id)
        .execute();

      if (error) {
        throw error;
      }

      onItemDeleted();
    } catch {
      alert('Failed to delete item');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!item.image_url || !token) return;

    let cancelled = false;

    const load = async () => {
      try {
        butterbase.setAccessToken(token);
        const { data, error } = await butterbase.storage.getDownloadUrl(item.image_url!);

        if (!cancelled && !error && data) {
          setImageUrl(data.url);
        }
      } catch (err) {
        console.error('Failed to load image', err);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [item.image_url, token]);

  return (
    <div
      style={{
        padding: '15px',
        border: '1px solid #ddd',
        marginBottom: '10px',
        backgroundColor: item.completed ? '#f0f8f0' : 'white',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <input
          type="checkbox"
          checked={item.completed}
          onChange={handleToggleGotIt}
          disabled={loading}
          title="Got it"
          style={{ marginTop: '5px' }}
        />
        <div style={{ flex: 1 }}>
          <h3
            style={{
              margin: '0 0 5px 0',
              textDecoration: item.completed ? 'line-through' : 'none',
            }}
          >
            {item.title}
          </h3>
          {item.description && (
            <p style={{ margin: '0 0 10px 0', color: '#666' }}>{item.description}</p>
          )}
          {imageUrl && (
            <img
              src={imageUrl}
              alt={item.title}
              style={{ maxWidth: '200px', maxHeight: '200px', display: 'block', marginTop: '10px' }}
            />
          )}
          <div style={{ fontSize: '12px', color: '#999', marginTop: '10px' }}>
            Added {new Date(item.created_at).toLocaleString()}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={loading}
          style={{
            padding: '5px 10px',
            backgroundColor: '#dc3545',
            color: 'white',
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
