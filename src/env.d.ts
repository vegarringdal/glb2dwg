/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The package.json version, set in vite.config.ts so the footer can show it. */
  readonly VITE_APP_VERSION: string;
}
