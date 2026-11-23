// Sends push notifications to the owner's phone when a task finishes.

import * as webpush from 'web-push';

/** Creates the push key pair on first use and stores it where every laptop's helper can read it. */
export async function ensurePushKeys(db) {
  const { data, error } = await db.from('app_secrets').select('value').eq('key', 'vapid').maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data.value;
  const keys = webpush.generateVAPIDKeys();
  const secrets = await db.from('app_secrets').insert({ key: 'vapid', value: keys });
  if (secrets.error) throw new Error(secrets.error.message);
  const settings = await db.from('app_settings').upsert({ key: 'vapid_public_key', value: keys.publicKey });
  if (settings.error) throw new Error(settings.error.message);
  return keys;
}

export function createPusher(db, config, log = () => {}) {
  let ready = null;

  async function init() {
    const { data } = await db.from('app_secrets').select('value').eq('key', 'vapid').maybeSingle();
    if (!data) return false;
    webpush.setVapidDetails(`mailto:${config.ownerEmail}`, data.value.publicKey, data.value.privateKey);
    return true;
  }

  return {
    /** payload: { title, body, url } */
    async notify(payload) {
      try {
        ready ??= init();
        if (!(await ready)) {
          ready = null;
          return;
        }
        const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth');
        await Promise.all(
          (subs ?? []).map(async (sub) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                JSON.stringify(payload),
                { TTL: 3600, urgency: 'high' },
              );
            } catch (err) {
              // 404 and 410 mean the phone dropped this subscription.
              if (err.statusCode === 404 || err.statusCode === 410) {
                await db.from('push_subscriptions').delete().eq('id', sub.id);
              } else {
                log('push failed:', err.statusCode ?? err.message);
              }
            }
          }),
        );
      } catch (err) {
        ready = null;
        log('push failed:', err.message);
      }
    },
  };
}
