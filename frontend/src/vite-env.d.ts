/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 仅开发模式：模拟后端 all | auto | off（默认 auto）。与模块无关，不影响生产构建。 */
  readonly VITE_CLOUDALBUM_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
