import { useState } from 'react';
import { defaultAssets } from '@/lib/defaultAssets';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Toast';
import { formatBytes } from '@/lib/utils';
import { Package, Image, Box, FileText, Music, Type, File, Search } from 'lucide-react';
import type { Asset } from '@/types';

const typeIcons: Record<Asset['type'], typeof Package> = {
  image: Image, model: Box, texture: Image, audio: Music, font: Type, file: File,
};

const typeColors: Record<Asset['type'], string> = {
  image: 'text-secondary', model: 'text-primary', texture: 'text-tertiary', audio: 'text-success', font: 'text-warning', file: 'text-outline',
};

export function AssetsManager() {
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Asset | null>(null);

  const filtered = defaultAssets.filter((a) => {
    if (filter !== 'all' && a.type !== filter) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const totalSize = defaultAssets.reduce((sum, a) => sum + a.size, 0);
  const types = ['all', 'image', 'model', 'texture', 'audio', 'font', 'file'];

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[1200px] mx-auto space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
              <Package className="text-primary" size={28} /> Asset Manager
            </h1>
            <p className="text-on-surface-variant text-sm mt-1">{defaultAssets.length} assets · {formatBytes(totalSize)} total</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-outline" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search assets..."
                className="bg-surface-low border border-outline-variant/20 rounded pl-8 pr-3 py-1.5 text-sm text-on-surface focus:border-primary/50 focus:outline-none w-48"
              />
            </div>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 flex-wrap">
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                filter === t
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5 border border-transparent'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Asset grid */}
          <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filtered.map((asset) => {
              const Icon = typeIcons[asset.type];
              return (
                <Card key={asset.id} hover className="p-3" onClick={() => setSelected(asset)}>
                  <div className="aspect-square bg-surface-lowest rounded-lg flex items-center justify-center mb-2">
                    <Icon size={32} className={typeColors[asset.type]} />
                  </div>
                  <div className="text-xs font-medium text-on-surface truncate">{asset.name}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[10px] text-outline font-mono">{formatBytes(asset.size)}</span>
                    <Badge>{asset.type}</Badge>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Inspector */}
          <div>
            {selected ? (
              <Card className="p-4 sticky top-0">
                <div className="aspect-square bg-surface-lowest rounded-lg flex items-center justify-center mb-4">
                  {(() => {
                    const Icon = typeIcons[selected.type];
                    return <Icon size={48} className={typeColors[selected.type]} />;
                  })()}
                </div>
                <h3 className="text-sm font-semibold text-on-surface mb-3">{selected.name}</h3>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-outline">Type</span>
                    <span className="text-on-surface-variant font-mono">{selected.type}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-outline">Size</span>
                    <span className="text-on-surface-variant font-mono">{formatBytes(selected.size)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-outline">Location</span>
                    <span className="text-on-surface-variant font-mono">{selected.location}</span>
                  </div>
                  {Object.entries(selected.metadata).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-xs">
                      <span className="text-outline">{k}</span>
                      <span className="text-on-surface-variant font-mono">{v}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : (
              <Card className="p-8 text-center">
                <FileText size={32} className="mx-auto text-outline mb-2" />
                <p className="text-sm text-on-surface-variant">Select an asset to inspect</p>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
