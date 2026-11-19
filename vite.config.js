import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // config change triggers a dev-server restart so .env is re-read

  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    historyApiFallback: true,
  },
   build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['echarts', 'echarts-for-react'],
          pdf: ['jspdf', 'html2canvas'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
});