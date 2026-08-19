// import { defineConfig } from 'vite';
// import react from '@vitejs/plugin-react';

// export default defineConfig({
//   plugins: [react()],
//   server: {
//     // 127.0.0.1 rather than 0.0.0.0 on purpose. The browser only grants
//     // microphone access in a secure context, and a bare LAN address over http
//     // is not one — the phone would register and then be unable to answer.
//     host: '127.0.0.1',
//     port: 5173,
//     strictPort: true,
//     // The API is proxied rather than called cross-origin, so the browser sees a
//     // single origin. That is what lets the session cookie be HttpOnly and
//     // SameSite=Lax: a cross-site cookie would need SameSite=None; Secure, which
//     // needs HTTPS, which this does not have. It also removes CORS entirely.
//     proxy: {
//       '/api': { target: 'http://127.0.0.1:5000', changeOrigin: false },
//     },
//   },
//   build: { outDir: 'dist', sourcemap: true },
// });




import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';

export default defineConfig({
  plugins: [react()],

  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,

    https: {
      key: fs.readFileSync('./certs/10.140.28.7-key.pem'),
      cert: fs.readFileSync('./certs/10.140.28.7.pem'),
    },

    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: false,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});