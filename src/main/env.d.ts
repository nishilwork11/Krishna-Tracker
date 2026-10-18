/// <reference types="vite/client" />

/** Build-time variables injected by electron-vite (from .env*, MAIN_VITE_ prefix). */
interface ImportMetaEnv {
  /** Production HRMS base URL, e.g. https://hrms.example.com */
  readonly MAIN_VITE_HRMS_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
