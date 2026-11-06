import { useLocale, text } from '../i18n';
import { GroceryItemRow } from './GroceryItemRow';
import type { GroceryItem } from '../types';

interface GroceryListProps {
  items: GroceryItem[];
  onItemUpdated: () => void;
  onItemDeleted: () => void;
}

export function GroceryList({ items, onItemUpdated, onItemDeleted }: GroceryListProps) {
  useLocale();
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>{text("Your list is empty. Add something above.")}</div>
    );
  }

  return (
    <div>
      <h2>{text("Items (")}{items.length}{text(")")}</h2>
      {items.map((item) => (
        <GroceryItemRow
          key={item.id}
          item={item}
          onItemUpdated={onItemUpdated}
          onItemDeleted={onItemDeleted}
        />
      ))}
    </div>
  );
}
