import { butterbase } from '../lib/butterbase';
import type { User } from '../types';

export async function signup(email: string, password: string) {
  const { data, error } = await butterbase.auth.signUp({ email, password });
  if (error || !data) throw error || new Error('Signup failed');
  return data; // { user, message }
}

export async function login(email: string, password: string) {
  const { data, error } = await butterbase.auth.signIn({ email, password });
  if (error || !data) throw error || new Error('Login failed');

  // Set token on client for subsequent requests
  butterbase.setAccessToken(data.access_token);
  return data;
}

export async function getCurrentUser(token: string): Promise<User> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.auth.getUser();
  if (error || !data) throw error || new Error('Failed to get user');
  return data;
}

export function getStoredToken(): string | null {
  return localStorage.getItem('token');
}

export function setStoredToken(token: string): void {
  localStorage.setItem('token', token);
}

export function clearStoredToken(): void {
  localStorage.removeItem('token');
}
