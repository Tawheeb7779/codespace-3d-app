import { useUIStore } from '@/stores/uiStore';
import { TopBar } from '@/components/layout/TopBar';
import { Sidebar } from '@/components/layout/Sidebar';
import { StatusBar } from '@/components/layout/StatusBar';
import { MobileNav } from '@/components/layout/MobileNav';
import { CommandPalette } from '@/components/CommandPalette';
import { ToastContainer } from '@/components/ui/Toast';
import { Dashboard } from '@/components/features/Dashboard';
import { Projects } from '@/components/features/Projects';
import { AssetsManager } from '@/components/features/AssetsManager';
import { StorageManager } from '@/components/features/StorageManager';
import { TeamManagement } from '@/components/features/TeamManagement';
import { TeamChat } from '@/components/features/TeamChat';
import { Notifications } from '@/components/features/Notifications';
import { GlobalSearch } from '@/components/features/GlobalSearch';
import { Settings } from '@/components/features/Settings';
import { Workspace } from '@/components/workspace/Workspace';

function App() {
  const currentView = useUIStore((s) => s.currentView);

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <Dashboard />;
      case 'workspace': return <Workspace />;
      case 'projects': return <Projects />;
      case 'assets': return <AssetsManager />;
      case 'storage': return <StorageManager />;
      case 'team': return <TeamManagement />;
      case 'chat': return <TeamChat />;
      case 'notifications': return <Notifications />;
      case 'search': return <GlobalSearch />;
      case 'settings': return <Settings />;
      default: return <Dashboard />;
    }
  };

  const isWorkspace = currentView === 'workspace';
  const isChat = currentView === 'chat';

  return (
    <div className="h-screen flex flex-col bg-background text-on-surface overflow-hidden">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar - hidden on mobile, hidden in chat/workspace views on desktop */}
        <aside
          className={`w-56 shrink-0 glass-panel border-r border-outline-variant/10 overflow-auto ${
            isWorkspace || isChat ? 'hidden md:block' : 'hidden md:block'
          }`}
        >
          <Sidebar />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex overflow-hidden">
          {renderView()}
        </main>
      </div>
      <StatusBar />
      <MobileNav />
      <CommandPalette />
      <ToastContainer />
    </div>
  );
}

export default App;
