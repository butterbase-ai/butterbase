import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TodoForm } from '../components/TodoForm';
import { TodoList } from '../components/TodoList';
import { useAuth } from '../contexts/AuthContext';
import { butterbase } from '../lib/butterbase';
import type { Todo } from '../types';
import { getTodoStats, searchTodos, exportTodos, type StatsResponse } from '../services/functions';

export function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Todo[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();

  const fetchTodos = async () => {
    if (!token) return;

    try {
      butterbase.setAccessToken(token);
      const { data, error } = await butterbase.from<Todo>('todos').execute();

      if (error || !data) {
        throw error || new Error('Failed to fetch todos');
      }

      setTodos(data);
      setError('');

      // Fetch stats after loading todos
      fetchStats();
    } catch (err: any) {
      setError(err.message || 'Failed to load todos');
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    if (!token) return;

    try {
      const data = await getTodoStats(token);
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  const handleSearch = useCallback(async (query: string) => {
    if (!token || !query.trim()) {
      setSearchResults(null);
      return;
    }

    setIsSearching(true);
    try {
      const data = await searchTodos(token, query);
      setSearchResults(data.results);
    } catch (err) {
      console.error('Search failed:', err);
      setSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  }, [token]);

  const handleExport = async (format: 'json' | 'csv') => {
    if (!token) return;

    try {
      const blob = await exportTodos(token, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `todos-${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  useEffect(() => {
    fetchTodos();
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery) {
        handleSearch(searchQuery);
      } else {
        setSearchResults(null);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '50px' }}>Loading...</div>;
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h1>My Todos</h1>
          <p style={{ color: '#666' }}>Welcome, {user?.email}</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => handleExport('json')}
            style={{ padding: '10px 15px', cursor: 'pointer', fontSize: '14px' }}
          >
            Export JSON
          </button>
          <button
            onClick={() => handleExport('csv')}
            style={{ padding: '10px 15px', cursor: 'pointer', fontSize: '14px' }}
          >
            Export CSV
          </button>
          <button
            onClick={handleLogout}
            style={{ padding: '10px 20px', cursor: 'pointer' }}
          >
            Logout
          </button>
        </div>
      </div>

      {stats && (
        <div style={{
          padding: '15px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'space-around',
          fontSize: '14px'
        }}>
          <div><strong>{stats.total}</strong> total</div>
          <div><strong>{stats.completed}</strong> completed</div>
          <div><strong>{stats.pending}</strong> pending</div>
          <div><strong>{stats.completionRate}%</strong> completion rate</div>
        </div>
      )}

      {error && (
        <div style={{ color: 'red', marginBottom: '20px', padding: '10px', backgroundColor: '#fee' }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: '20px' }}>
        <input
          type="text"
          placeholder="Search todos..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '16px',
            border: '1px solid #ddd',
            borderRadius: '4px'
          }}
        />
        {isSearching && <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>Searching...</div>}
      </div>

      <TodoForm onTodoCreated={fetchTodos} />
      <TodoList
        todos={searchResults !== null ? searchResults : todos}
        onTodoUpdated={fetchTodos}
        onTodoDeleted={fetchTodos}
      />
    </div>
  );
}
