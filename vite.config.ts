import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import monacoEditorPluginModule from "vite-plugin-monaco-editor";
import path from "path";

const monacoEditorPlugin = (monacoEditorPluginModule as any).default || monacoEditorPluginModule;

const host = process.env.TAURI_DEV_HOST;

// Only bundle commonly-used Shiki language grammars (saves ~8 MB in build).
// Languages not listed here will gracefully degrade (no syntax highlighting).
const SHIKI_ALLOWED_LANGS = new Set([
  "angular-html", "angular-ts", "astro", "bash", "c", "cpp", "csharp",
  "css", "dart", "dockerfile", "go", "graphql", "html", "html-derivative",
  "java", "javascript", "json", "json5", "jsonc", "jsx", "kotlin", "less",
  "lua", "markdown", "mdc", "mdx", "objective-c", "objective-cpp", "php",
  "python", "ruby", "rust", "sass", "scss", "shell", "shellscript",
  "sql", "svelte", "swift", "toml", "tsx", "typescript", "vue",
  "vue-html", "xml", "yaml",
]);

function shikiLanguageFilter(): Plugin {
  return {
    name: "shiki-language-filter",
    enforce: "pre",
    resolveId(id) {
      const m = id.match(/^@shikijs\/langs\/(.+)$/);
      if (m && !SHIKI_ALLOWED_LANGS.has(m[1])) {
        return "\0shiki-lang-noop";
      }
      return null;
    },
    load(id) {
      if (id === "\0shiki-lang-noop") {
        return "export default []";
      }
      return null;
    },
  };
}

function stripLinkedDistPureAnnotations(): Plugin {
  const markstreamReactDist = "/libs/markstream-vue/packages/markstream-react/dist/";

  return {
    name: "strip-linked-dist-pure-annotations",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").includes(markstreamReactDist) || !code.includes("@__PURE__")) {
        return null;
      }

      return {
        code: code.replace(/\/\*\s*@__PURE__\s*\*\//g, ""),
        map: null,
      };
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), monacoEditorPlugin({}), shikiLanguageFilter(), stripLinkedDistPureAnnotations()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "stream-monaco": path.resolve(__dirname, "./libs/stream-monaco"),
      "stream-markdown-parser": path.resolve(__dirname, "./libs/markstream-vue/packages/markdown-parser"),
    },
  },
  clearScreen: false,
  server: {
    port: 1300,
    strictPort: false,
    host: host || '127.0.0.1',
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  build: {
    chunkSizeWarningLimit: 9000,
  },
}));
