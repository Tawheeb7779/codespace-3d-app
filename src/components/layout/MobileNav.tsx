import { useUIStore } from '@/stores/uiStore';
import { Sidebar } from './Sidebar';
import { X } from 'lucide-react';

export function MobileNav() {
  const { mobileNavOpen, setMobileNavOpen } = useUIStore();

  if (!mobileNavOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] md:hidden">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={() => setMobileNavOpen(false)}
      />
      <div className="absolute left-0 top-0 bottom-0 w-64 glass-elevated animate-slide-in flex flex-col">
        <div className="flex items-center justify-between px-3 py-3 border-b border-outline-variant/10">
          <span className="font-headline-md text-base font-bold text-gradient">CodeSpace 3D</span>
          <button
            onClick={() => setMobileNavOpen(false)}
            className="p-1 rounded text-on-surface-variant hover:text-on-surface"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
