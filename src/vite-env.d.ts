/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Optional — absent means Local Development Mode. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key. Never the service-role key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'esbuild-wasm/esbuild.wasm?url' {
  const url: string;
  export default url;
}
