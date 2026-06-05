import { Actor, log } from 'apify';

await Actor.init();

const input = await Actor.getInput() || {};

const {
  profileUrls = [],
  batchSize = 5,
  maxPostsPerProfile = 15,
  includeReposts = false,
  onlyPosts = true,
  dedupeByPostUrl = true,
  debug = false,
} = input;

if (!Array.isArray(profileUrls) || profileUrls.length === 0) {
  throw new Error('Missing required input: profileUrls must be a non-empty array');
}

const client = Actor.newClient();

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildTaskInput(batch) {
  return {
    startUrls: batch.map(url => ({ url })),
    maxItems: maxPostsPerProfile,
    includeReposts: false
  };
}

function normalizeItem(item, fallbackProfile) {
  // Tries several common field names returned by LinkedIn scraping actors.
  const postUrl = item.postUrl || item.url || item.activityUrl || null;
  const text = item.text || item.content || item.description || item.headline || '';
  const authorName = item.authorName || item.author || item.profileName || null;
  const authorUrl = item.authorUrl || item.profileUrl || fallbackProfile || null;
  const timestamp = item.timestamp || item.postedAt || item.date || null;
  const postType = item.postType || item.type || null;
  const imageUrl = item.imageUrl || item.image || null;
  const sourceProfile = item.sourceProfile || fallbackProfile || null;

  return {
    sourceProfile,
    authorName,
    authorUrl,
    text,
    headline: item.headline || text,
    postUrl,
    postType,
    timestamp,
    imageUrl,
    raw: item,
  };
}

const batches = chunk(profileUrls, batchSize);
const allNormalized = [];
const seen = new Set();

log.info(`Starting wrapper for ${profileUrls.length} profiles in ${batches.length} batch(es).`);

for (let idx = 0; idx < batches.length; idx++) {
  const batch = batches[idx];
  const taskInput = buildTaskInput(batch);

  if (debug) {
    log.info(`Calling source task for batch ${idx + 1}/${batches.length}`, { batch, taskInput });
  }

  const run = await Actor.call('parseforge/linkedin-posts-scraper', taskInput);

  if (!run?.defaultDatasetId) {
    throw new Error(`Source task run for batch ${idx + 1} did not return defaultDatasetId`);
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });

  if (debug) {
    log.info(`Fetched ${items.length} raw item(s) from source dataset`, { datasetId: run.defaultDatasetId });
  }

  // Try to backfill sourceProfile if the source task didn't return it.
  const batchFallbackProfile = batch.length === 1 ? batch[0] : null;

  for (const rawItem of items) {
    const normalized = normalizeItem(rawItem, batchFallbackProfile);
    const dedupeKey = normalized.postUrl || `${normalized.authorName || 'unknown'}::${normalized.text || ''}`;

    if (dedupeByPostUrl && seen.has(dedupeKey)) continue;
    if (dedupeByPostUrl) seen.add(dedupeKey);

    allNormalized.push(normalized);
  }
}

log.info(`Pushing ${allNormalized.length} normalized item(s) to wrapper dataset.`);
await Actor.pushData(allNormalized);
await Actor.exit();
