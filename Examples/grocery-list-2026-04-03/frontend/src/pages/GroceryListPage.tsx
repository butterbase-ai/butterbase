import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { GroceryForm } from '../components/GroceryForm';
import { GroceryList } from '../components/GroceryList';
import { RecipeChatPanel } from '../components/RecipeChatPanel';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { GroceryItem } from '../types';

export function GroceryListPage() {
  const [items, setItems] = useState<GroceryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();

  const fetchItems = useCallback(async () => {
    if (!token) return;

    try {
      butterbase.setAccessToken(token);
      const { data, error } = await butterbase.from<GroceryItem>('grocery_items').execute();

      if (error || !data) {
        throw error || new Error('Failed to fetch grocery items');
      }

      setItems(data);
      setError('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load list';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '50px' }}>Loading...</div>;
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
        }}
      >
        <div>
          <h1>Grocery list</h1>
          <p style={{ color: '#666' }}>Signed in as {user?.email}</p>
        </div>
        <button onClick={handleLogout} style={{ padding: '10px 20px', cursor: 'pointer' }}>
          Logout
        </button>
      </div>

      {error && (
        <div style={{ color: 'red', marginBottom: '20px', padding: '10px', backgroundColor: '#fee' }}>
          {error}
        </div>
      )}

      <GroceryForm onItemCreated={fetchItems} />
      <GroceryList items={items} onItemUpdated={fetchItems} onItemDeleted={fetchItems} />
      <RecipeChatPanel token={token} />
    </div>
  );
}
