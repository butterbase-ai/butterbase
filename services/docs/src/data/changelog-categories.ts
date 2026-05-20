export type RoadmapCategory =
  | 'auth'
  | 'database'
  | 'storage'
  | 'functions'
  | 'deploy'
  | 'compute'
  | 'ai'
  | 'realtime'
  | 'integrations'
  | 'tooling'
  | 'ops';

export interface CategoryMeta {
  /** Short label shown on chips and badges. */
  label: string;
  /** Foreground color for badge text and chip text. */
  textColor: string;
  /** Background color for the badge pill. */
  badgeBg: string;
  /** Border color for the chip when not selected. */
  chipBorder: string;
}

export const categories: Record<RoadmapCategory, CategoryMeta> = {
  auth:         { label: 'Auth',         textColor: 'hsl(150 35% 65%)', badgeBg: 'hsl(150 25% 12%)', chipBorder: 'hsl(150 25% 22%)' },
  database:     { label: 'Database',     textColor: 'hsl(43 60% 70%)',  badgeBg: 'hsl(43 25% 12%)',  chipBorder: 'hsl(43 25% 22%)' },
  storage:      { label: 'Storage',      textColor: 'hsl(25 55% 70%)',  badgeBg: 'hsl(25 25% 12%)',  chipBorder: 'hsl(25 25% 22%)' },
  functions:    { label: 'Functions',    textColor: 'hsl(200 45% 70%)', badgeBg: 'hsl(200 25% 12%)', chipBorder: 'hsl(200 25% 22%)' },
  deploy:       { label: 'Deploy',       textColor: 'hsl(280 35% 70%)', badgeBg: 'hsl(280 25% 12%)', chipBorder: 'hsl(280 25% 22%)' },
  compute:      { label: 'Compute',      textColor: 'hsl(260 35% 72%)', badgeBg: 'hsl(260 25% 13%)', chipBorder: 'hsl(260 25% 22%)' },
  ai:           { label: 'AI',           textColor: 'hsl(340 40% 70%)', badgeBg: 'hsl(340 25% 12%)', chipBorder: 'hsl(340 25% 22%)' },
  realtime:     { label: 'Realtime',     textColor: 'hsl(180 35% 70%)', badgeBg: 'hsl(180 25% 12%)', chipBorder: 'hsl(180 25% 22%)' },
  integrations: { label: 'Integrations', textColor: 'hsl(170 35% 70%)', badgeBg: 'hsl(170 25% 12%)', chipBorder: 'hsl(170 25% 22%)' },
  tooling:      { label: 'Tooling',      textColor: 'hsl(35 15% 70%)',  badgeBg: 'hsl(35 15% 14%)',  chipBorder: 'hsl(35 15% 22%)' },
  ops:          { label: 'Ops',          textColor: 'hsl(220 15% 70%)', badgeBg: 'hsl(220 15% 14%)', chipBorder: 'hsl(220 15% 22%)' },
};

/** Stable display order for chips. Derived from `categories` so it can never drift out of sync with the union. */
export const categoryOrder = Object.keys(categories) as RoadmapCategory[];
