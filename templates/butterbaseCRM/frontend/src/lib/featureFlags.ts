// Runtime feature flags toggled from the browser devtools console.
// Each flag is a localStorage key; set to '1' to enable, remove to disable.
// Example:
//   localStorage.setItem('bb:ai-assistant', '1'); location.reload();
//   localStorage.removeItem('bb:ai-assistant'); location.reload();

export const FLAGS = {
  supportWidget: 'bb:support-widget',
  aiAssistant: 'bb:ai-assistant',
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export function isFlagEnabled(key: FlagKey): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
