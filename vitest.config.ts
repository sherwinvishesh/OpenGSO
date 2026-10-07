import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.{ts,js}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'examples/**'],
    environment: 'node',
  },
});
