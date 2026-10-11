import { UiError } from '../i18n';
import { butterbase } from '../lib/butterbase';
import type { RecipeChatMessage, RecipeChatResponse } from '../types';

export async function sendRecipeChat(
  token: string,
  messages: RecipeChatMessage[]
): Promise<RecipeChatResponse> {
  butterbase.setAccessToken(token);
  const { data, error } = await butterbase.functions.invoke<RecipeChatResponse>(
    'grocery-recipe-chat',
    { body: { messages } }
  );
  if (error || !data) throw error || new UiError("Recipe chat request failed");
  return data;
}
