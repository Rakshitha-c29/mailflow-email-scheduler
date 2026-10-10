import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Logo } from './Logo';
import { useSlackRedirectToast } from '../../lib/useSlackRedirectToast';

/** Sidebar + content. Below md the sidebar becomes a slide-in drawer. */
export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  useSlackRedirectToast();
  useEffect(() => setDrawer(false), [location]);

  return (
    <div className="flex h-full bg-white">
      <aside className="hidden w-[272px] shrink-0 md:block">
        <Sidebar />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/20" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-[272px] bg-white shadow-xl">
            <button onClick={() => setDrawer(false)} className="absolute top-3 right-3 p-1 text-gray-400" aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 px-4 pt-3 md:hidden">
          <button onClick={() => setDrawer(true)} className="p-1 text-gray-600" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo />
        </div>
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
