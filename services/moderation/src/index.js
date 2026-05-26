import { buildApp } from './app.js';

const port = Number(process.env.MODERATION_PORT || 8081);
const app = buildApp();

app.listen(port, () => {
  console.log(`[moderation] listening on :${port}`);
});
