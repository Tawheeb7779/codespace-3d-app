import { useProjectStore } from '@/stores/projectStore';
import { useUIStore } from '@/stores/uiStore';
import { useEditorStore } from '@/stores/editorStore';
import { Button } from '@/components/ui/Button';
import { InspectorSection, InspectorField, NumberInput, ColorInput, SliderInput } from '@/components/ui/InspectorSection';
import { Box, Circle, Cylinder, Triangle, Donut, Square, Eye, EyeOff, Trash2 } from 'lucide-react';
import type { SceneObject } from '@/types';

const objectTypes: { type: SceneObject['type']; icon: typeof Box; label: string }[] = [
  { type: 'box', icon: Box, label: 'Box' },
  { type: 'sphere', icon: Circle, label: 'Sphere' },
  { type: 'cylinder', icon: Cylinder, label: 'Cylinder' },
  { type: 'cone', icon: Triangle, label: 'Cone' },
  { type: 'torus', icon: Donut, label: 'Torus' },
  { type: 'plane', icon: Square, label: 'Plane' },
];

export function Inspector() {
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const updateSceneObject = useProjectStore((s) => s.updateSceneObject);
  const deleteSceneObject = useProjectStore((s) => s.deleteSceneObject);
  const addSceneObject = useProjectStore((s) => s.addSceneObject);
  const { centerView } = useUIStore();
  const activeFileId = useEditorStore((s) => s.activeFileId);

  if (centerView === 'scene') {
    const sceneObjects = activeProject?.sceneObjects ?? [];
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-outline-variant/10">
          <span className="font-label-caps text-label-caps text-on-surface-variant">Scene Inspector</span>
        </div>
        <div className="flex-1 overflow-auto">
          <InspectorSection title="Add Object">
            <div className="grid grid-cols-3 gap-1">
              {objectTypes.map(({ type, icon: Icon, label }) => (
                <button
                  key={type}
                  onClick={() => activeProject && addSceneObject(activeProject.id, {
                    name: `${label} ${sceneObjects.length + 1}`,
                    type,
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                    color: '#4d8eff',
                    metalness: 0.3,
                    roughness: 0.5,
                    visible: true,
                  })}
                  className="flex flex-col items-center gap-1 p-2 rounded glass-elevated glow-active text-on-surface-variant hover:text-on-surface transition-all"
                >
                  <Icon size={16} />
                  <span className="text-[10px]">{label}</span>
                </button>
              ))}
            </div>
          </InspectorSection>
          <InspectorSection title="Scene Hierarchy">
            {sceneObjects.length === 0 ? (
              <p className="text-xs text-outline py-2">No objects in scene</p>
            ) : (
              sceneObjects.map((obj) => (
                <div key={obj.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-white/5 transition-colors group">
                  <button onClick={() => updateSceneObject(activeProject!.id, obj.id, { visible: !obj.visible })}>
                    {obj.visible ? <Eye size={12} className="text-outline" /> : <EyeOff size={12} className="text-outline" />}
                  </button>
                  <span className="text-xs text-on-surface-variant flex-1 truncate">{obj.name}</span>
                  <button onClick={() => deleteSceneObject(activeProject!.id, obj.id)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <Trash2 size={12} className="text-error" />
                  </button>
                </div>
              ))
            )}
          </InspectorSection>
          {sceneObjects.length > 0 && (
            <InspectorSection title="Last Object Properties">
              {(() => {
                const obj = sceneObjects[sceneObjects.length - 1];
                return (
                  <>
                    <InspectorField label="Name">
                      <input
                        value={obj.name}
                        onChange={(e) => updateSceneObject(activeProject!.id, obj.id, { name: e.target.value })}
                        className="bg-surface-low border border-outline-variant/20 rounded px-2 py-1 text-xs text-on-surface focus:border-primary/50 focus:outline-none w-28"
                      />
                    </InspectorField>
                    <InspectorField label="Color">
                      <ColorInput value={obj.color} onChange={(v) => updateSceneObject(activeProject!.id, obj.id, { color: v })} />
                    </InspectorField>
                    <InspectorField label="Metal">
                      <SliderInput value={obj.metalness} onChange={(v) => updateSceneObject(activeProject!.id, obj.id, { metalness: v })} />
                    </InspectorField>
                    <InspectorField label="Rough">
                      <SliderInput value={obj.roughness} onChange={(v) => updateSceneObject(activeProject!.id, obj.id, { roughness: v })} />
                    </InspectorField>
                    <div className="space-y-1 pt-1">
                      <div className="text-[10px] text-outline font-label-caps">Position</div>
                      <div className="flex gap-1">
                        {obj.position.map((val, i) => (
                          <NumberInput key={i} value={val} onChange={(v) => {
                            const pos = [...obj.position] as [number, number, number];
                            pos[i] = v;
                            updateSceneObject(activeProject!.id, obj.id, { position: pos });
                          }} />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[10px] text-outline font-label-caps">Scale</div>
                      <div className="flex gap-1">
                        {obj.scale.map((val, i) => (
                          <NumberInput key={i} value={val} step={0.1} onChange={(v) => {
                            const scale = [...obj.scale] as [number, number, number];
                            scale[i] = v;
                            updateSceneObject(activeProject!.id, obj.id, { scale: scale });
                          }} />
                        ))}
                      </div>
                    </div>
                  </>
                );
              })()}
            </InspectorSection>
          )}
        </div>
      </div>
    );
  }

  const file = activeProject?.files.find((f) => f.id === activeFileId);
  if (!file) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-outline-variant/10">
          <span className="font-label-caps text-label-caps text-on-surface-variant">Inspector</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-outline text-xs p-4 text-center">
          No file selected
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-outline-variant/10">
        <span className="font-label-caps text-label-caps text-on-surface-variant">File Inspector</span>
      </div>
      <div className="flex-1 overflow-auto">
        <InspectorSection title="File Info">
          <InspectorField label="Name">
            <span className="text-xs font-mono text-on-surface">{file.name}</span>
          </InspectorField>
          <InspectorField label="Type">
            <span className="text-xs font-mono text-on-surface-variant">{file.type}</span>
          </InspectorField>
          <InspectorField label="Language">
            <span className="text-xs font-mono text-on-surface-variant">{file.language ?? 'plaintext'}</span>
          </InspectorField>
          <InspectorField label="Size">
            <span className="text-xs font-mono text-on-surface-variant">{(file.content?.length ?? 0)} chars</span>
          </InspectorField>
        </InspectorSection>
        <InspectorSection title="Collaboration">
          <div className="flex -space-x-1.5">
            <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-[10px] text-on-primary font-bold border-2 border-surface-low">AC</div>
            <div className="w-6 h-6 rounded-full bg-tertiary flex items-center justify-center text-[10px] text-on-tertiary font-bold border-2 border-surface-low">SK</div>
            <div className="w-6 h-6 rounded-full bg-success flex items-center justify-center text-[10px] text-on-surface font-bold border-2 border-surface-low">LP</div>
          </div>
        </InspectorSection>
      </div>
    </div>
  );
}
