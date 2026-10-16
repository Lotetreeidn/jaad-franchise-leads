// Optional companion Worker that gives the Pages deployment a schedule (Pages has no cron of its own).
// Paste this into a new Worker in the Cloudflare dashboard, then set:
//   Variable  APP_URL      = https://<your-pages-project>.pages.dev   (no trailing slash)
//   Secret    CRON_SECRET  = the same CRON_SECRET you set on the Pages project
//   Triggers  Cron         = 15 2 * * *  and  15 10 * * *   (09:15 and 17:15 WIB)
// The app itself still does nothing until the switches are turned on in Pengaturan.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(fetch(`${env.APP_URL}/api/cron`, { method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` } })
      .then(async r => console.log("cron", r.status, (await r.text()).slice(0, 500))));
  },
  async fetch() {
    return new Response("JAAD franchise cron worker. Nothing to see here.", { status: 404 });
  },
};
