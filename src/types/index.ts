export type ProjectTemplate = 'blank' | 'threejs' | 'react' | 'react-three' | 'html';

export interface ProjectFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  parentId: string | null;
  content?: string;
  language?: string;
  children?: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  template: ProjectTemplate;
  createdAt: number;
  updatedAt: number;
  files: ProjectFile[];
  sceneObjects?: SceneObject[];
}

export interface SceneObject {
  id: string;
  name: string;
  type: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'group';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: string;
  metalness: number;
  roughness: number;
  visible: boolean;
  children?: string[];
}

export interface EditorTab {
  fileId: string;
  dirty: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'Owner' | 'Admin' | 'Developer' | 'Viewer';
  online: boolean;
  avatar: string;
  lastSeen?: number;
}

export interface ChatChannel {
  id: string;
  name: string;
  type: 'project' | 'team' | 'direct';
  unread: number;
  members: string[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
}

export interface AppNotification {
  id: string;
  type: 'project' | 'team' | 'system';
  title: string;
  message: string;
  read: boolean;
  timestamp: number;
}

export interface Asset {
  id: string;
  name: string;
  type: 'image' | 'model' | 'texture' | 'audio' | 'font' | 'file';
  size: number;
  location: string;
  thumbnail?: string;
  metadata: Record<string, string>;
}

export interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'info';
  content: string;
  timestamp: number;
}

export type ViewMode = 'dashboard' | 'workspace' | 'projects' | 'assets' | 'storage' | 'team' | 'chat' | 'notifications' | 'search' | 'settings';
export type CenterView = 'editor' | 'preview' | 'scene';
export type BottomTab = 'terminal' | 'problems' | 'output' | 'logs';
