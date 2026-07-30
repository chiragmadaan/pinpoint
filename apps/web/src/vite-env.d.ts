/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the hosted /dev/ build to reveal the dev menu (see deploy workflow). */
  readonly VITE_DEV_TOOLS?: string;
  /** App version (from apps/web/package.json) + short build SHA — injected in vite.config.ts. */
  readonly VITE_APP_VERSION: string;
  readonly VITE_BUILD_SHA: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
