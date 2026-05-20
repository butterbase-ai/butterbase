export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface Todo {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  completed: boolean;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTodoInput {
  title: string;
  description?: string;
  image_url?: string;
}

export interface UpdateTodoInput {
  title?: string;
  description?: string;
  completed?: boolean;
  image_url?: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user: User;
}

export interface PresignedUploadResponse {
  uploadUrl: string;
  objectKey: string;
  objectId: string;
  expiresIn: number;
}

export interface PresignedDownloadResponse {
  downloadUrl: string;
  filename: string;
  expiresIn: number;
}
