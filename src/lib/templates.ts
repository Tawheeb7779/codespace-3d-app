import type { ProjectFile } from '@/types';

let fid = 0;
const id = () => `f_${Date.now()}_${fid++}`;

export function createTemplateFiles(template: string): ProjectFile[] {
  switch (template) {
    case 'react':
      return reactTemplate();
    case 'threejs':
      return threejsTemplate();
    case 'react-three':
      return reactThreeTemplate();
    case 'html':
      return htmlTemplate();
    default:
      return blankTemplate();
  }
}

function blankTemplate(): ProjectFile[] {
  const rootId = id();
  const srcId = id();
  return [
    { id: rootId, name: 'project', type: 'folder', parentId: null, children: [srcId] },
    { id: srcId, name: 'src', type: 'folder', parentId: rootId, children: [] },
    { id: id(), name: 'README.md', type: 'file', parentId: rootId, language: 'markdown', content: '# New Project\n\nStart building something amazing.' },
  ];
}

function reactTemplate(): ProjectFile[] {
  const rootId = id();
  const srcId = id();
  const componentsId = id();
  const appFileId = id();
  const mainFileId = id();
  const compFileId = id();
  return [
    { id: rootId, name: 'react-app', type: 'folder', parentId: null, children: [srcId] },
    { id: srcId, name: 'src', type: 'folder', parentId: rootId, children: [appFileId, mainFileId, componentsId] },
    { id: componentsId, name: 'components', type: 'folder', parentId: srcId, children: [compFileId] },
    {
      id: appFileId,
      name: 'App.tsx',
      type: 'file',
      parentId: srcId,
      language: 'typescript',
      content: `import { useState } from 'react';\nimport { Counter } from './components/Counter';\n\nfunction App() {\n  const [count, setCount] = useState(0);\n  return (\n    <div style={{ padding: 40, fontFamily: 'sans-serif' }}>\n      <h1>React App</h1>\n      <Counter count={count} onIncrement={() => setCount(c => c + 1)} />\n    </div>\n  );\n}\n\nexport default App;\n`,
    },
    {
      id: mainFileId,
      name: 'main.tsx',
      type: 'file',
      parentId: srcId,
      language: 'typescript',
      content: `import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
    },
    {
      id: compFileId,
      name: 'Counter.tsx',
      type: 'file',
      parentId: componentsId,
      language: 'typescript',
      content: `interface CounterProps {\n  count: number;\n  onIncrement: () => void;\n}\n\nexport function Counter({ count, onIncrement }: CounterProps) {\n  return (\n    <button onClick={onIncrement}>\n      Count: {count}\n    </button>\n  );\n}\n`,
    },
    { id: id(), name: 'package.json', type: 'file', parentId: rootId, language: 'json', content: '{\n  "name": "react-app",\n  "version": "1.0.0",\n  "dependencies": {\n    "react": "^18.0.0",\n    "react-dom": "^18.0.0"\n  }\n}\n' },
  ];
}

function threejsTemplate(): ProjectFile[] {
  const rootId = id();
  const srcId = id();
  const mainId = id();
  const sceneId = id();
  return [
    { id: rootId, name: 'threejs-app', type: 'folder', parentId: null, children: [srcId] },
    { id: srcId, name: 'src', type: 'folder', parentId: rootId, children: [mainId, sceneId] },
    {
      id: mainId,
      name: 'main.js',
      type: 'file',
      parentId: srcId,
      language: 'javascript',
      content: `import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n\nconst scene = new THREE.Scene();\nconst camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);\nconst renderer = new THREE.WebGLRenderer({ antialias: true });\nrenderer.setSize(window.innerWidth, window.innerHeight);\ndocument.body.appendChild(renderer.domElement);\n\nconst geometry = new THREE.BoxGeometry(1, 1, 1);\nconst material = new THREE.MeshStandardMaterial({ color: 0x4d8eff, metalness: 0.3, roughness: 0.5 });\nconst cube = new THREE.Mesh(geometry, material);\nscene.add(cube);\n\nconst light = new THREE.DirectionalLight(0xffffff, 1);\nlight.position.set(5, 5, 5);\nscene.add(light);\nscene.add(new THREE.AmbientLight(0x404040));\n\ncamera.position.z = 5;\nconst controls = new OrbitControls(camera, renderer.domElement);\n\nfunction animate() {\n  requestAnimationFrame(animate);\n  cube.rotation.x += 0.01;\n  cube.rotation.y += 0.01;\n  controls.update();\n  renderer.render(scene, camera);\n}\nanimate();\n`,
    },
    {
      id: sceneId,
      name: 'scene.js',
      type: 'file',
      parentId: srcId,
      language: 'javascript',
      content: `// Scene configuration\nexport const sceneConfig = {\n  background: 0x05070d,\n  fog: { color: 0x05070d, near: 10, far: 50 },\n  lights: [\n    { type: 'directional', intensity: 1, position: [5, 5, 5] },\n    { type: 'ambient', intensity: 0.4 },\n  ],\n};\n`,
    },
    { id: id(), name: 'index.html', type: 'file', parentId: rootId, language: 'html', content: '<!DOCTYPE html>\n<html>\n  <head>\n    <title>Three.js App</title>\n    <style>body{margin:0;overflow:hidden;}</style>\n  </head>\n  <body>\n    <script type="module" src="./src/main.js"></script>\n  </body>\n</html>\n' },
  ];
}

function reactThreeTemplate(): ProjectFile[] {
  const rootId = id();
  const srcId = id();
  const appId = id();
  const mainId = id();
  return [
    { id: rootId, name: 'r3f-app', type: 'folder', parentId: null, children: [srcId] },
    { id: srcId, name: 'src', type: 'folder', parentId: rootId, children: [appId, mainId] },
    {
      id: appId,
      name: 'App.tsx',
      type: 'file',
      parentId: srcId,
      language: 'typescript',
      content: `import { Canvas } from '@react-three/fiber';\nimport { OrbitControls, Box } from '@react-three/drei';\n\nfunction App() {\n  return (\n    <Canvas camera={{ position: [0, 0, 5] }}>\n      <ambientLight intensity={0.4} />\n      <directionalLight position={[5, 5, 5]} intensity={1} />\n      <Box args={[1, 1, 1]}>\n        <meshStandardMaterial color="#4d8eff" metalness={0.3} roughness={0.5} />\n      </Box>\n      <OrbitControls />\n    </Canvas>\n  );\n}\n\nexport default App;\n`,
    },
    {
      id: mainId,
      name: 'main.tsx',
      type: 'file',
      parentId: srcId,
      language: 'typescript',
      content: `import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
    },
  ];
}

function htmlTemplate(): ProjectFile[] {
  const rootId = id();
  const indexId = id();
  const styleId = id();
  const scriptId = id();
  return [
    { id: rootId, name: 'html-app', type: 'folder', parentId: null, children: [indexId, styleId, scriptId] },
    {
      id: indexId,
      name: 'index.html',
      type: 'file',
      parentId: rootId,
      language: 'html',
      content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>HTML App</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div id="app">\n    <h1>Hello World</h1>\n    <p>Start building your app.</p>\n  </div>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
    },
    {
      id: styleId,
      name: 'style.css',
      type: 'file',
      parentId: rootId,
      language: 'css',
      content: `* { margin: 0; padding: 0; box-sizing: border-box; }\nbody { font-family: sans-serif; padding: 40px; background: #0e131d; color: #dee2f1; }\nh1 { color: #adc6ff; }\n`,
    },
    {
      id: scriptId,
      name: 'script.js',
      type: 'file',
      parentId: rootId,
      language: 'javascript',
      content: `console.log('App started');\n\ndocument.getElementById('app').addEventListener('click', () => {\n  console.log('Clicked');\n});\n`,
    },
  ];
}
