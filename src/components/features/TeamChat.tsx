import { useState, useRef, useEffect } from 'react';
import { useTeamStore } from '@/stores/teamStore';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Toast';
import { formatTime } from '@/lib/utils';
import { Hash, Send, Users, MessageSquare } from 'lucide-react';

export function TeamChat() {
  const { channels, messages, selectedChannelId, selectChannel, sendMessage, markChannelRead, members } = useTeamStore();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const channelMessages = messages.filter((m) => m.channelId === selectedChannelId);
  const selectedChannel = channels.find((c) => c.id === selectedChannelId);
  const channelMembers = selectedChannel
    ? members.filter((m) => selectedChannel.members.includes(m.id))
    : [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [channelMessages]);

  useEffect(() => {
    if (selectedChannelId) markChannelRead(selectedChannelId);
  }, [selectedChannelId, markChannelRead]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !selectedChannelId) return;
    sendMessage(selectedChannelId, 'm1', 'Alex Chen', input.trim());
    setInput('');
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Channel list */}
      <div className="w-48 sm:w-56 shrink-0 glass-panel border-r border-outline-variant/10 flex flex-col">
        <div className="px-3 py-2 border-b border-outline-variant/10">
          <span className="font-label-caps text-label-caps text-on-surface-variant">Channels</span>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {channels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => selectChannel(channel.id)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                selectedChannelId === channel.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-white/5 hover:text-on-surface'
              }`}
            >
              <Hash size={14} className="shrink-0" />
              <span className="flex-1 truncate text-left">{channel.name}</span>
              {channel.unread > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-error/20 text-error text-[10px] font-mono">
                  {channel.unread}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="px-3 py-2 border-t border-outline-variant/10">
          <div className="flex items-center gap-1.5 text-xs text-outline">
            <Users size={12} />
            <span>{members.filter((m) => m.online).length} online</span>
          </div>
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedChannel ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-outline-variant/10 shrink-0">
              <div className="flex items-center gap-2">
                <Hash size={16} className="text-outline" />
                <span className="text-sm font-semibold text-on-surface">{selectedChannel.name}</span>
                <Badge color={selectedChannel.type === 'project' ? 'primary' : 'secondary'}>
                  {selectedChannel.type}
                </Badge>
              </div>
              <span className="text-xs text-outline">{channelMembers.length} members</span>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
              {channelMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-outline">
                  <MessageSquare size={32} className="mb-2" />
                  <p className="text-sm">No messages yet. Start the conversation!</p>
                </div>
              ) : (
                channelMessages.map((msg) => {
                  const author = members.find((m) => m.id === msg.authorId);
                  return (
                    <div key={msg.id} className="flex gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-on-primary text-xs font-bold shrink-0">
                        {author?.avatar ?? msg.authorName.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-semibold text-on-surface">{msg.authorName}</span>
                          <span className="text-[10px] text-outline font-mono">{formatTime(msg.timestamp)}</span>
                        </div>
                        <p className="text-sm text-on-surface-variant mt-0.5 break-words">{msg.content}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <form onSubmit={handleSend} className="flex items-center gap-2 px-4 py-2 border-t border-outline-variant/10 shrink-0">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Message #${selectedChannel.name}...`}
                className="flex-1 bg-surface-low border border-outline-variant/20 rounded px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary/50 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!input.trim()}
                className="p-2 rounded bg-primary text-on-primary disabled:opacity-40 hover:bg-primary-fixed transition-colors"
              >
                <Send size={16} />
              </button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-outline">
            <p className="text-sm">Select a channel</p>
          </div>
        )}
      </div>
    </div>
  );
}
