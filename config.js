// Where the API (Cloudflare Worker) lives. Change PROD_API after `npm run deploy` in worker/.
const PROD_API = 'https://api.badminton-parkville.workers.dev';

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = isLocal ? `http://${location.hostname}:8787` : PROD_API;
