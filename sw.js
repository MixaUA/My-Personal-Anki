const CACHE_NAME = 'smart-code-v2';
const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    './icon/favicon.ico',
    './icon/favicon-16x16.png',
    './icon/favicon-32x32.png',
    './icon/apple-touch-icon.png',
    './icon/android-chrome-192x192.png',
    './icon/android-chrome-512x512.png',
    'https://fonts.googleapis.com/css2?family=Gochi+Hand&family=Indie+Flower&display=swap'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
