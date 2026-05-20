import { butterbase } from '../lib/butterbase';

export interface StatsResponse {
  total: number;
  completed: number;
  pending: number;
  withImages: number;
  completionRate: number;
}

export interface SearchResult {
  id: string;
  title: string;
  description: string | null;
  completed: boolean;
  image_url: string | null;
  created_at: string;
  user_id: string;
  updated_at: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  count: number;
  results: SearchResult[];
}

export async function getTodoStats(token: string): Promise<StatsResponse> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.functions.invoke<StatsResponse>('todo-stats');
  if (error || !data) throw error || new Error('Failed to fetch stats');
  return data;
}

export async function searchTodos(token: string, query: string): Promise<SearchResponse> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.functions.invoke<SearchResponse>(
    `search-todos?q=${encodeURIComponent(query)}`
  );
  if (error || !data) throw error || new Error('Failed to search todos');
  return data;
}

export async function exportTodos(token: string, format: 'json' | 'csv'): Promise<Blob> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.functions.invokeBlob(
    `export-todos?format=${format}`
  );
  if (error || !data) throw error || new Error('Failed to export todos');
  return data;
}
