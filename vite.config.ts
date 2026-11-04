import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// base './' so the app works from any address, including a GitHub Pages project page (user.github.io/repo/).
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
