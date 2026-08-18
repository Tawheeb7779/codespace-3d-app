import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Toast';
import { Settings as SettingsIcon, Palette, Monitor, Keyboard, Database, Bell, User } from 'lucide-react';

export function Settings() {
  const [theme, setTheme] = useState('deep-space');
  const [fontSize, setFontSize] = useState(14);
  const [tabSize, setTabSize] = useState(2);
  const [autoSave, setAutoSave] = useState(true);
  const [minimap, setMinimap] = useState(true);
  const [notifications, setNotifications] = useState(true);

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[800px] mx-auto space-y-4">
        <div>
          <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
            <SettingsIcon className="text-primary" size={28} /> Settings
          </h1>
          <p className="text-on-surface-variant text-sm mt-1">Configure your CodeSpace 3D environment</p>
        </div>

        {/* Profile */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2 mb-4 pb-2 border-b border-outline-variant/10">
            <User size={16} className="text-outline" /> Profile
          </h2>
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-on-primary text-xl font-bold">
              AC
            </div>
            <div>
              <div className="text-sm font-semibold text-on-surface">Alex Chen</div>
              <div className="text-xs text-outline">alex@codespace3d.dev</div>
              <Badge color="primary">Owner</Badge>
            </div>
          </div>
        </Card>

        {/* Editor */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2 mb-4 pb-2 border-b border-outline-variant/10">
            <Monitor size={16} className="text-outline" /> Editor
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-on-surface-variant">Font Size</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setFontSize((f) => Math.max(10, f - 1))} className="w-7 h-7 rounded glass-elevated text-on-surface hover:bg-surface-high transition-colors">-</button>
                <span className="text-sm font-mono text-on-surface w-8 text-center">{fontSize}px</span>
                <button onClick={() => setFontSize((f) => Math.min(24, f + 1))} className="w-7 h-7 rounded glass-elevated text-on-surface hover:bg-surface-high transition-colors">+</button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-on-surface-variant">Tab Size</span>
              <select
                value={tabSize}
                onChange={(e) => setTabSize(parseInt(e.target.value))}
                className="bg-surface-low border border-outline-variant/20 rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary/50"
              >
                {[2, 4, 8].map((s) => <option key={s} value={s}>{s} spaces</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-on-surface-variant">Show Minimap</span>
              <button
                onClick={() => setMinimap(!minimap)}
                className={`w-10 h-5 rounded-full transition-colors ${minimap ? 'bg-primary' : 'bg-surface-high'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${minimap ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-on-surface-variant">Auto Save</span>
              <button
                onClick={() => setAutoSave(!autoSave)}
                className={`w-10 h-5 rounded-full transition-colors ${autoSave ? 'bg-primary' : 'bg-surface-high'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${autoSave ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
        </Card>

        {/* Appearance */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2 mb-4 pb-2 border-b border-outline-variant/10">
            <Palette size={16} className="text-outline" /> Appearance
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {['deep-space', 'midnight', 'carbon'].map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`p-3 rounded-lg border text-left transition-all ${theme === t ? 'bg-primary/10 border-primary/30' : 'glass-elevated border-outline-variant/10 hover:bg-surface-high'}`}
              >
                <div className={`w-full h-12 rounded mb-2 ${t === 'deep-space' ? 'bg-gradient-to-br from-[#0e131d] to-[#1b202a]' : t === 'midnight' ? 'bg-gradient-to-br from-[#0a0a1a] to-[#1a1a3a]' : 'bg-gradient-to-br from-[#1a1a1a] to-[#2a2a2a]'}`} />
                <span className="text-xs font-medium text-on-surface capitalize">{t.replace('-', ' ')}</span>
              </button>
            ))}
          </div>
        </Card>

        {/* Notifications */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-on-surface flex items-center gap-2 mb-4 pb-2 border-b border-outline-variant/10">
            <Bell size={16} className="text-outline" /> Notifications
          </h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-on-surface-variant">Enable notifications</span>
            <button
              onClick={() => setNotifications(!notifications)}
              className={`w-10 h-5 rounded-full transition-colors ${notifications ? 'bg-primary' : 'bg-surface-high'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${notifications ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="ghost">Reset to defaults</Button>
          <Button variant="primary">Save Changes</Button>
        </div>
      </div>
    </div>
  );
}
