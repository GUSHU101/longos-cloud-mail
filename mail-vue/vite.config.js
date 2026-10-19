import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import {ElementPlusResolver} from 'unplugin-vue-components/resolvers'
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), 'VITE')
    return {
        server: {
            host: true,
            port: 3001,
            hmr: true,
        },
        base: env.VITE_STATIC_URL || '/',
        plugins: [vue(),
            VitePWA({
                injectRegister: 'script-defer',
                manifest: {
                    name: env.VITE_PWA_NAME,
                    short_name: env.VITE_PWA_NAME,
                    background_color: '#FFFFFF',
                    theme_color: '#FFFFFF',
                    icons: [
                        {
                            src: 'mail-pwa.png',
                            sizes: '192x192',
                            type: 'image/png',
                        }
                    ],
                },
                workbox: {
                    disableDevLogs: true,
                    globPatterns: [],
                    runtimeCaching: [],
                    navigateFallback: null,
                    cleanupOutdatedCaches: true,
                }
            }),
            AutoImport({
                resolvers: [ElementPlusResolver()],
                dts: false,
            }),
            Components({
                resolvers: [ElementPlusResolver()],
                dts: false,
            })
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src')
            }
        },
        build: {
            target: 'es2022',
			chunkSizeWarningLimit: 600,
            outDir: env.VITE_OUT_DIR || 'dist',
            emptyOutDir: true,
			assetsInclude: ['**/*.json'],
			rollupOptions: {
				output: {
					manualChunks(id) {
						if (!id.includes('node_modules')) return undefined
						if (/node_modules[\\/](@vue|vue|pinia|vue-router|vue-i18n)[\\/]/.test(id)) return 'vue-vendor'
						if (id.includes('node_modules/echarts') || id.includes('node_modules\\echarts')) return 'charts'
						if (id.includes('node_modules/dexie') || id.includes('node_modules\\dexie')) return 'database'
						if (id.includes('node_modules/@iconify') || id.includes('node_modules\\@iconify')) return 'icons'
						return undefined
					}
				}
			}
        }
    }
})
