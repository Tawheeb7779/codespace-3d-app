import { useState } from 'react';
import { useTeamStore } from '@/stores/teamStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Users, UserPlus, Crown, Shield, Code, Eye, Trash2 } from 'lucide-react';
import type { TeamMember } from '@/types';

const roleIcons: Record<TeamMember['role'], typeof Crown> = {
  Owner: Crown, Admin: Shield, Developer: Code, Viewer: Eye,
};

const roleColors: Record<TeamMember['role'], string> = {
  Owner: 'text-tertiary', Admin: 'text-primary', Developer: 'text-secondary', Viewer: 'text-outline',
};

export function TeamManagement() {
  const { members, removeMember, addMember, updateMember } = useTeamStore();
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamMember['role']>('Developer');

  const handleInvite = () => {
    if (!inviteName.trim() || !inviteEmail.trim()) return;
    addMember({
      name: inviteName.trim(),
      email: inviteEmail.trim(),
      role: inviteRole,
      online: false,
      avatar: inviteName.trim().slice(0, 2).toUpperCase(),
      lastSeen: Date.now(),
    });
    setShowInvite(false);
    setInviteName('');
    setInviteEmail('');
    setInviteRole('Developer');
  };

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[1200px] mx-auto space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface flex items-center gap-2">
              <Users className="text-primary" size={28} /> Team Management
            </h1>
            <p className="text-on-surface-variant text-sm mt-1">{members.length} members · {members.filter((m) => m.online).length} online</p>
          </div>
          <Button variant="primary" onClick={() => setShowInvite(true)}>
            <UserPlus size={16} /> Invite Member
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {members.map((member) => {
            const RoleIcon = roleIcons[member.role];
            return (
              <Card key={member.id} className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-on-primary text-sm font-bold">
                        {member.avatar}
                      </div>
                      <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-surface-lowest ${member.online ? 'bg-success' : 'bg-outline'}`} />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-on-surface">{member.name}</div>
                      <div className="text-xs text-outline">{member.email}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => { if (confirm(`Remove ${member.name}?`)) removeMember(member.id); }}
                    className="p-1 rounded text-outline hover:text-error transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div className={`flex items-center gap-1.5 text-xs ${roleColors[member.role]}`}>
                    <RoleIcon size={14} />
                    <span className="font-medium">{member.role}</span>
                  </div>
                  <span className="text-[10px] text-outline font-mono">
                    {member.online ? 'Online now' : `Last seen ${new Date(member.lastSeen ?? Date.now()).toLocaleDateString()}`}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Modal open={showInvite} onClose={() => setShowInvite(false)} title="Invite Team Member">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-label-caps text-on-surface-variant mb-1.5">Name</label>
            <input
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              placeholder="Jane Doe"
              className="w-full bg-surface-low border border-outline-variant/20 rounded px-3 py-2 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-label-caps text-on-surface-variant mb-1.5">Email</label>
            <input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="jane@codespace3d.dev"
              className="w-full bg-surface-low border border-outline-variant/20 rounded px-3 py-2 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-label-caps text-on-surface-variant mb-1.5">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {(['Developer', 'Admin', 'Viewer', 'Owner'] as const).map((r) => {
                const Icon = roleIcons[r];
                return (
                  <button
                    key={r}
                    onClick={() => setInviteRole(r)}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-left transition-all ${
                      inviteRole === r
                        ? 'bg-primary/10 border-primary/30 text-on-surface'
                        : 'glass-elevated border-outline-variant/10 text-on-surface-variant hover:bg-surface-high'
                    }`}
                  >
                    <Icon size={16} className={inviteRole === r ? roleColors[r] : 'text-outline'} />
                    <span className="text-xs font-medium">{r}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleInvite} disabled={!inviteName.trim() || !inviteEmail.trim()}>
              <UserPlus size={16} /> Send Invite
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
