import { useNotificationStore } from '@/stores/notificationStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Toast';
import { formatTimeAgo } from '@/lib/utils';
import { Bell, CheckCheck, Trash2, FolderGit2, Users, Settings as SettingsIcon } from 'lucide-react';
import type { AppNotification } from '@/types';

const typeIcons: Record<AppNotification['type'], typeof Bell> = {
  project: FolderGit2, team: Users, system: SettingsIcon,
};

const typeColors: Record<AppNotification['type'], string> = {
  project: 'text-primary', team: 'text-secondary', system: 'text-tertiary',
};

export function Notifications() {
  const { notifications, markAsRead, markAllAsRead, clearAll, clearRead } = useNotificationStore();
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[800px] mx-auto space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
              <Bell className="text-primary" size={28} /> Notifications
            </h1>
            <p className="text-on-surface-variant text-sm mt-1">{unreadCount} unread</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={markAllAsRead} disabled={unreadCount === 0}>
              <CheckCheck size={14} /> Mark all read
            </Button>
            <Button variant="ghost" onClick={clearRead}>
              <Trash2 size={14} /> Clear read
            </Button>
          </div>
        </div>

        {notifications.length === 0 ? (
          <Card className="p-12 text-center">
            <Bell size={40} className="mx-auto text-outline mb-3" />
            <p className="text-sm text-on-surface-variant">No notifications</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {notifications.map((notif) => {
              const Icon = typeIcons[notif.type];
              return (
                <Card
                  key={notif.id}
                  hover
                  className={`p-4 flex items-start gap-3 ${notif.read ? 'opacity-60' : ''}`}
                  onClick={() => markAsRead(notif.id)}
                >
                  <div className={`w-9 h-9 rounded-lg bg-surface-lowest flex items-center justify-center shrink-0 ${typeColors[notif.type]}`}>
                    <Icon size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-on-surface">{notif.title}</span>
                      {!notif.read && <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
                      <Badge color={notif.type === 'project' ? 'primary' : notif.type === 'team' ? 'secondary' : 'tertiary'}>
                        {notif.type}
                      </Badge>
                    </div>
                    <p className="text-xs text-on-surface-variant">{notif.message}</p>
                    <span className="text-[10px] text-outline font-mono mt-1 block">{formatTimeAgo(notif.timestamp)}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {notifications.length > 0 && (
          <div className="flex justify-center pt-2">
            <Button variant="danger" onClick={() => { if (confirm('Clear all notifications?')) clearAll(); }}>
              <Trash2 size={14} /> Clear all
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
