import {defineConfig} from 'vite';
// A local-only test page. No proxy or backend is exposed.
export default defineConfig({server:{host:'127.0.0.1',port:4020,strictPort:true,fs:{deny:['**/data/**','**/keystore/**','**/.env*','**/*.sqlite','**/*.sqlite-*','**/*.db','**/*.keystore.json']}},build:{sourcemap:false,rolldownOptions:{onwarn(warning,defaultHandler){if(warning.code==='MODULE_LEVEL_DIRECTIVE'&&warning.message.includes('use client'))return;defaultHandler(warning)}}}});
