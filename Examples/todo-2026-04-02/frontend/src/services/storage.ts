import { butterbase } from '../lib/butterbase';
import type { PresignedUploadResponse, PresignedDownloadResponse } from '../types';

export async function uploadImage(
  file: File,
  token: string
): Promise<PresignedUploadResponse> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.storage.upload(file);
  if (error || !data) throw error || new Error('Failed to upload image');

  // Return format matching existing type
  return {
    uploadUrl: '', // Not exposed by SDK
    objectKey: data.objectKey,
    objectId: data.objectId,
    expiresIn: 0, // Not exposed by SDK
  };
}

export async function getDownloadUrl(
  objectId: string,
  token: string
): Promise<PresignedDownloadResponse> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.storage.getDownloadUrl(objectId);
  if (error || !data) throw error || new Error('Failed to get download URL');

  // Return format matching existing type
  return {
    downloadUrl: data.url,
    filename: data.filename,
    expiresIn: 0, // Not exposed by SDK
  };
}

export async function deleteImage(
  objectId: string,
  token: string
): Promise<void> {
  butterbase.setAccessToken(token);
  const { error } = await butterbase.storage.delete(objectId);
  if (error) throw error;
}
