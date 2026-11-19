import type { ReactNode } from 'react';
import { useLocale, text, errorMessage, UiError } from '../i18n';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { GroceryForm } from '../components/GroceryForm';
import { GroceryList } from '../components/GroceryList';
import { RecipeChatPanel } from '../components/RecipeChatPanel';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { GroceryItem } from '../types';

export function GroceryListPage() {
  useLocale();
  const [items, setItems] = useState<GroceryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReactNode>('');
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();

  const fetchItems = useCallback(async () => {
    if (!token) return;

    try {
      butterbase.setAccessToken(token);
      const { data, error } = await butterbase.from<GroceryItem>('grocery_items').execute();

      if (error || !data) {
        throw error || new UiError("Failed to fetch grocery items");
      }

      setItems(data);
      setError('');
    } catch (err: unknown) {
      const message = errorMessage(err, "Failed to load list");
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
    return <div style={{ textAlign: 'center', padding: '50px' }}>{text("Loading...")}</div>;
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap', gap: '12px',
          alignItems: 'center',
          marginBottom: '20px',
        }}
      >
        <div>
          <h1>{text("Grocery list")}</h1>
          <p style={{ color: '#666' }}>{text("Signed in as")}{' '}{user?.email}</p>
        </div>
        <button onClick={handleLogout} style={{ padding: '10px 20px', cursor: 'pointer' }}>{text("Logout")}</button>
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
