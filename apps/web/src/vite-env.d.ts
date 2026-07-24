/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the hosted /dev/ build to reveal the dev menu (see deploy workflow). */
  readonly VITE_DEV_TOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
