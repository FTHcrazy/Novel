import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import { RENDERER_ENTRY_PATHS, WINDOW_ENTRIES } from './electron/window-entries'
import {
  FEATURE_REGISTRY,
  croppedWindowEntries,
  disabledFeatures,
  resolveFeatureFlags,
} from './src/shared/feature-registry'

/**
 * 构建期特性开关（**注册表驱动**，唯一事实源：`src/shared/feature-registry.ts`）。
 *
 * 这里只做两件事：按注册表读环境变量求值 → 把结果注入每一份产物。
 * 新增 / 下线一个开关只改注册表（含它对应的环境变量名与默认值），本文件不用动。
 * 例：注册表里 `env: "NOVEL_WITH_XXX"` 的开关，用 `NOVEL_WITH_XXX=0 pnpm electron:build`
 * 即可裁掉；默认全开。值是**编译期字面量**，不是运行时开关。
 */
const FEATURES = resolveFeatureFlags(process.env)

/** 注入主进程 / preload / 渲染层三份产物的编译期常量 */
const FEATURE_DEFINES = { __NOVEL_FEATURES__: JSON.stringify(FEATURES) }

// 被裁掉的特性若登记了窗口入口，就从 rollup input 里剔掉 —— 该窗口的 HTML 与
// chunk 根本不会产出（而非产出后没人用）。判断逻辑在注册表侧，便于单测。
const croppedEntries = new Set(croppedWindowEntries(FEATURES))

const off = disabledFeatures(FEATURES)
if (off.length > 0) {
  const detail = off.map((key) => `${key}(${FEATURE_REGISTRY[key].env})`).join(', ')
  console.log(`[vite] 已按构建参数裁掉特性：${detail}；被裁窗口入口：${[...croppedEntries].join(', ') || '无'}`)
}

// 窗口入口清单：electron/window-entries.ts 是唯一事实源（主进程运行期共用）。
const windowEntries = WINDOW_ENTRIES.filter((key) => !croppedEntries.has(key))
const rendererInputs = Object.fromEntries(
  windowEntries.map((key) => [key, path.resolve(__dirname, RENDERER_ENTRY_PATHS[key])]),
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // 主进程入口
        entry: 'electron/main.ts',
        onstart() {
          // 不自动启动 Electron，由 concurrently 在 dev server 就绪后启动
        },
        vite: {
          // 特性开关必须注入主进程产物：main.ts 靠它决定是否注册 map IPC
          define: FEATURE_DEFINES,
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
            // 主进程运行时 Node 模块保持 require，不打入 bundle：
            // - electron / better-sqlite3：原生模块
            // - mammoth：解析 .docx 导入书籍的纯 Node 库，其传递依赖（如
            //   jszip→readable-stream→core-util-is）在 pnpm 非扁平结构下
            //   rolldown 无法解析，故整体 external
            // - jszip：数据迁移的 zip 编解码 + 敏感词包解压，同属 Node 侧依赖
            external: ['electron', 'better-sqlite3', 'mammoth', 'jszip'],
            },
          },
        },
      },
      {
        // 预加载脚本
        entry: 'electron/preload.ts',
        onstart() {
          // 不调用 reload()，防止插件自动启动 Electron
          // preload 变更后需手动重启 dev
        },
        vite: {
          // preload 与主进程共用同一份开关值，避免两侧判断不一致
          define: FEATURE_DEFINES,
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
  base: './',
  // 渲染层产物同款开关：工具箱入口卡与帮助手册靠它决定是否提到地图
  define: FEATURE_DEFINES,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // 预优化重型依赖，加速首次页面加载
  // pixi.js：地图窗口的 WebGL 渲染内核（体量大、内部模块多，预构建收益明显）；
  // 地图窗口被裁掉时没必要再预构建它。
  optimizeDeps: {
    include: [
      'antd',
      '@ant-design/icons',
      'react',
      'react-dom',
      ...(FEATURES.mapWindow ? ['pixi.js'] : []),
    ],
  },
  build: {
    rollupOptions: {
      // 每个独立窗口一个 HTML 入口，清单见 electron/window-entries.ts
      input: rendererInputs,
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'vendor'
          }
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) {
            return 'antd'
          }
        },
      },
    },
  },
})
