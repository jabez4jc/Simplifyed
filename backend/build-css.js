import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

console.log('🎨 Building CSS with Tailwind and DaisyUI...');

try {
  // Build Tailwind CSS
  execSync('npx tailwindcss -i ./public/css/modern.css -o ./public/css/tailwind.css --minify', {
    stdio: 'inherit',
    cwd: __dirname
  });

  console.log('✅ CSS built successfully!');
  console.log('📦 Output: ./public/css/tailwind.css');
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}
