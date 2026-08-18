import type { Asset } from '@/types';

const defaultAssets: Asset[] = [
  { id: 'a1', name: 'cube_diffuse.png', type: 'texture', size: 4_200_000, location: '/assets/textures/', metadata: { format: 'PNG', resolution: '2048x2048', channels: 'RGBA' } },
  { id: 'a2', name: 'cube_normal.png', type: 'texture', size: 3_800_000, location: '/assets/textures/', metadata: { format: 'PNG', resolution: '2048x2048', channels: 'RGBA' } },
  { id: 'a3', name: 'hero_mesh.glb', type: 'model', size: 12_500_000, location: '/assets/models/', metadata: { format: 'GLB', vertices: '24,532', materials: '4' } },
  { id: 'a4', name: 'ambient_loop.mp3', type: 'audio', size: 2_100_000, location: '/assets/audio/', metadata: { format: 'MP3', duration: '0:45', bitrate: '320kbps' } },
  { id: 'a5', name: 'inter.ttf', type: 'font', size: 340_000, location: '/assets/fonts/', metadata: { format: 'TTF', weights: '400,600,700' } },
  { id: 'a6', name: 'background.jpg', type: 'image', size: 1_800_000, location: '/assets/images/', metadata: { format: 'JPEG', resolution: '3840x2160' } },
  { id: 'a7', name: 'particle.png', type: 'texture', size: 120_000, location: '/assets/textures/', metadata: { format: 'PNG', resolution: '512x512' } },
  { id: 'a8', name: 'robot.glb', type: 'model', size: 8_200_000, location: '/assets/models/', metadata: { format: 'GLB', vertices: '18,200', materials: '6' } },
  { id: 'a9', name: 'config.json', type: 'file', size: 2_400, location: '/config/', metadata: { format: 'JSON' } },
];

export { defaultAssets };
