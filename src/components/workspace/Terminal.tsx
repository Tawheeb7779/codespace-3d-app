import { useState, useRef, useEffect } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { formatTime } from '@/lib/utils';
import { Terminal as TerminalIcon, Trash2, ChevronRight } from 'lucide-react';

export function Terminal() {
  const lines = useTerminalStore((s) => s.lines);
  const executeCommand = useTerminalStore((s) => s.executeCommand);
  const clear = useTerminalStore((s) => s.clear);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    executeCommand(input);
    setHistory((prev) => [...prev, input]);
    setHistoryIdx(-1);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(newIdx);
      setInput(history[newIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      const newIdx = historyIdx + 1;
      if (newIdx >= history.length) {
        setHistoryIdx(-1);
        setInput('');
      } else {
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      }
    }
  };

  const typeColors: Record<string, string> = {
    input: 'text-primary',
    output: 'text-on-surface-variant',
    error: 'text-error',
    info: 'text-secondary',
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0d14]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-outline-variant/10 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-outline" />
          <span className="font-label-caps text-label-caps text-on-surface-variant">Terminal</span>
        </div>
        <button onClick={clear} className="p-1 rounded text-outline hover:text-on-surface hover:bg-white/5 transition-colors">
          <Trash2 size={12} />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto p-2 font-mono text-xs space-y-0.5" onClick={() => inputRef.current?.focus()}>
        {lines.map((line) => (
          <div key={line.id} className={`flex gap-2 ${typeColors[line.type] ?? 'text-on-surface-variant'}`}>
            {line.type === 'input' && <ChevronRight size={12} className="shrink-0 mt-0.5 text-primary" />}
            <span className="shrink-0 text-outline w-16 hidden sm:inline">{formatTime(line.timestamp)}</span>
            <span className="whitespace-pre-wrap break-all">{line.content}</span>
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2 px-2 py-1.5 border-t border-outline-variant/10 shrink-0">
        <ChevronRight size={14} className="text-primary shrink-0" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          className="flex-1 bg-transparent text-xs font-mono text-on-surface placeholder:text-outline focus:outline-none"
          autoFocus
        />
      </form>
    </div>
  );
}
