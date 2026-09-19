/// <reference types="vite/client" />

declare module '*.css?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
