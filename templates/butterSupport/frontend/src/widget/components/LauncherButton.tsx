import { X } from 'lucide-react';
import { BrandMark } from './BrandMark';

export function LauncherButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={open ? 'Close support' : 'Open support'}
      className="bs-shadow relative inline-flex h-14 w-14 items-center justify-center rounded-full text-[#2A1C0A] transition-all duration-300 hover:scale-105 active:scale-95"
      style={{
        background: 'linear-gradient(135deg, #FBE08E 0%, #F5C842 50%, #E0A82E 100%)',
        boxShadow:
          '0 0 0 1px rgba(232, 168, 46, 0.4), 0 10px 28px -6px rgba(245, 200, 66, 0.55), 0 4px 10px -2px rgba(20, 16, 12, 0.18), inset 0 1px 0 rgba(255,255,255,0.4)',
      }}
    >
      {!open && (
        <span
          className="absolute inset-0 rounded-full opacity-0 hover:opacity-100 transition-opacity"
          style={{
            background:
              'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.4), transparent 60%)',
          }}
        />
      )}
      <span className="relative transition-transform duration-300" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
        {open ? <X className="h-6 w-6" strokeWidth={2.4} /> : <BrandMark size={30} />}
      </span>
    </button>
  );
}
