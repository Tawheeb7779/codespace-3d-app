import { useState } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { Button } from '@/components/ui/Button';
import { RefreshCw, Maximize2, Monitor, Tablet, Smartphone, ExternalLink } from 'lucide-react';

export function LivePreview() {
  const { previewSize, setPreviewSize } = useUIStore();
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const fileContents = useEditorStore((s) => s.fileContents);
  const [refreshKey, setRefreshKey] = useState(0);

  const buildPreviewHTML = (): string => {
    if (!activeProject) return '<p style="color:#888;font-family:sans-serif;padding:40px;">No active project</p>';

    const htmlFile = activeProject.files.find((f) => f.name === 'index.html' && f.type === 'file');
    if (htmlFile) {
      let html = fileContents[htmlFile.id] ?? htmlFile.content ?? '';
      activeProject.files.forEach((f) => {
        if (f.type === 'file' && f.name !== 'index.html') {
          const content = fileContents[f.id] ?? f.content ?? '';
          const tag = f.name.endsWith('.css')
            ? `<style>${content}</style>`
            : f.name.endsWith('.js') || f.name.endsWith('.ts')
            ? `<script>${content}</script>`
            : '';
          html = html.replace(new RegExp(`<script src="${f.name}"></script>`, 'g'), tag);
          html = html.replace(new RegExp(`<link[^>]*href="${f.name}"[^>]*>`, 'g'), tag);
        }
      });
      return html;
    }

    const mainFile = activeProject.files.find((f) => f.name === 'main.tsx' || f.name === 'App.tsx');
    if (mainFile) {
      const content = fileContents[mainFile.id] ?? mainFile.content ?? '';
      return `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;padding:40px;background:#0e131d;color:#dee2f1}</style></head><body><pre style="white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:13px;color:#adc6ff">${content.replace(/</g, '&lt;')}</pre><p style="margin-top:20px;color:#8c909f">React/Three.js preview requires a build step. This is a static view of your source.</p></body></html>`;
    }

    const anyFile = activeProject.files.find((f) => f.type === 'file' && f.content);
    if (anyFile) {
      const content = fileContents[anyFile.id] ?? anyFile.content ?? '';
      return `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'JetBrains Mono',monospace;padding:20px;background:#0e131d;color:#dee2f1;font-size:13px;white-space:pre-wrap}</style></head><body>${content.replace(/</g, '&lt;')}</body></html>`;
    }

    return '<p style="color:#888;font-family:sans-serif;padding:40px;">No previewable content found</p>';
  };

  const sizes = {
    desktop: '100%',
    tablet: '768px',
    mobile: '375px',
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-outline-variant/10 shrink-0">
        <span className="font-label-caps text-label-caps text-on-surface-variant">Live Preview</span>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 mr-2">
            <button onClick={() => setPreviewSize('desktop')} className={`p-1 rounded transition-colors ${previewSize === 'desktop' ? 'bg-primary/10 text-primary' : 'text-outline hover:text-on-surface'}`} title="Desktop">
              <Monitor size={14} />
            </button>
            <button onClick={() => setPreviewSize('tablet')} className={`p-1 rounded transition-colors ${previewSize === 'tablet' ? 'bg-primary/10 text-primary' : 'text-outline hover:text-on-surface'}`} title="Tablet">
              <Tablet size={14} />
            </button>
            <button onClick={() => setPreviewSize('mobile')} className={`p-1 rounded transition-colors ${previewSize === 'mobile' ? 'bg-primary/10 text-primary' : 'text-outline hover:text-on-surface'}`} title="Mobile">
              <Smartphone size={14} />
            </button>
          </div>
          <button onClick={() => setRefreshKey((k) => k + 1)} className="p-1 rounded text-outline hover:text-on-surface transition-colors" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button className="p-1 rounded text-outline hover:text-on-surface transition-colors" title="Fullscreen">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center bg-[#05070d] overflow-hidden p-2">
        <div
          className="bg-white h-full transition-all duration-300 rounded overflow-hidden shadow-2xl"
          style={{ width: sizes[previewSize], maxWidth: '100%' }}
        >
          <iframe
            key={refreshKey}
            title="preview"
            srcDoc={buildPreviewHTML()}
            className="w-full h-full border-0"
            sandbox="allow-scripts"
          />
        </div>
      </div>
    </div>
  );
}
