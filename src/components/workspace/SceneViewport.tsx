import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, TransformControls } from '@react-three/drei';
import { useProjectStore } from '@/stores/projectStore';
import { useState, useRef } from 'react';
import * as THREE from 'three';
import type { SceneObject } from '@/types';

function SceneMesh({ obj, selected, onSelect, onChange }: {
  obj: SceneObject;
  selected: boolean;
  onSelect: () => void;
  onChange: (updates: Partial<SceneObject>) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);

  const geometry = (() => {
    switch (obj.type) {
      case 'box': return <boxGeometry args={[1, 1, 1]} />;
      case 'sphere': return <sphereGeometry args={[0.5, 32, 32]} />;
      case 'cylinder': return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />;
      case 'cone': return <coneGeometry args={[0.5, 1, 32]} />;
      case 'torus': return <torusGeometry args={[0.4, 0.15, 16, 64]} />;
      case 'plane': return <planeGeometry args={[1, 1]} />;
      default: return <boxGeometry args={[1, 1, 1]} />;
    }
  })();

  return (
    <TransformControls
      object={ref}
      mode="translate"
      onObjectChange={() => {
        if (!ref.current) return;
        onChange({
          position: [ref.current.position.x, ref.current.position.y, ref.current.position.z],
        });
      }}
    >
      <mesh
        ref={ref}
        position={obj.position}
        rotation={obj.rotation}
        scale={obj.scale}
        visible={obj.visible}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'default'; }}
      >
        {geometry}
        <meshStandardMaterial
          color={obj.color}
          metalness={obj.metalness}
          roughness={obj.roughness}
          emissive={selected ? '#4d8eff' : '#000000'}
          emissiveIntensity={selected ? 0.3 : 0}
        />
      </mesh>
    </TransformControls>
  );
}

export function SceneViewport() {
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const updateSceneObject = useProjectStore((s) => s.updateSceneObject);
  const addSceneObject = useProjectStore((s) => s.addSceneObject);
  const deleteSceneObject = useProjectStore((s) => s.deleteSceneObject);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sceneObjects = activeProject?.sceneObjects ?? [];

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant">
        <p className="text-sm">No active project</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-outline-variant/10 shrink-0">
        <span className="font-label-caps text-label-caps text-on-surface-variant">3D Viewport</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => addSceneObject(activeProject.id, {
              name: `Object ${sceneObjects.length + 1}`,
              type: 'box',
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
              color: '#4d8eff',
              metalness: 0.3,
              roughness: 0.5,
              visible: true,
            })}
            className="px-2 py-0.5 rounded text-xs glass-elevated text-on-surface hover:bg-surface-high transition-colors"
          >
            + Add Object
          </button>
          {selectedId && (
            <button
              onClick={() => {
                deleteSceneObject(activeProject.id, selectedId);
                setSelectedId(null);
              }}
              className="px-2 py-0.5 rounded text-xs bg-error/10 text-error border border-error/20 hover:bg-error/20 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 relative bg-[#05070d]">
        <Canvas camera={{ position: [5, 5, 5], fov: 50 }}>
          <ambientLight intensity={0.4} />
          <directionalLight position={[5, 5, 5]} intensity={1} castShadow />
          <directionalLight position={[-5, 3, -5]} intensity={0.3} />
          <Grid
            args={[20, 20]}
            cellSize={1}
            cellThickness={0.5}
            cellColor="#424754"
            sectionSize={5}
            sectionThickness={1}
            sectionColor="#4d8eff"
            fadeDistance={30}
            fadeStrength={1}
            position={[0, -0.5, 0]}
          />
          <axesHelper args={[3]} />
          {sceneObjects.map((obj) => (
            <SceneMesh
              key={obj.id}
              obj={obj}
              selected={selectedId === obj.id}
              onSelect={() => setSelectedId(obj.id)}
              onChange={(updates) => updateSceneObject(activeProject.id, obj.id, updates)}
            />
          ))}
          <OrbitControls makeDefault />
          <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
            <GizmoViewport axisColors={['#ff6b6b', '#4ade80', '#60a5fa']} labelColor="#dee2f1" />
          </GizmoHelper>
        </Canvas>
        <div className="absolute top-2 left-2 text-[10px] font-mono text-outline bg-surface-lowest/80 px-2 py-1 rounded">
          {sceneObjects.length} objects · {selectedId ? '1 selected' : 'Click to select'}
        </div>
      </div>
    </div>
  );
}
