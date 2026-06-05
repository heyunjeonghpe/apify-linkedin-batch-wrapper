import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const {
    profileUrls = [],
    maxPostsPerProfile = 10,
    maxScrolls = 8,
    includeReposts = false,
    debug = false,
    loginCookiesJson = '',
} = input;

if (!Array.isArray(profileUrls) || profileUrls.length === 0) {
    throw new Error('Missing required input: profileUrls must be a non-empty array');
}

let cookies = [];
if (loginCookiesJson) {
    try {
        cookies = typeof loginCookiesJson === 'string'
            ? JSON.parse(loginCookiesJson)
            : loginCookiesJson;
    } catch (err) {
        throw new Error(`loginCookiesJson is not valid JSON: ${err.message}`);
    }
}

function toRecentActivityUrl(url) {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean.includes('/recent-activity/')) return clean;
    return `${clean}/recent-activity/all/`;
}

function normalizeUrl(url) {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('/')) return `https://www.linkedin.com${url}`;
    return url;
}

function parseRelativeTimestamp(raw) {
    if (!raw || typeof raw !== 'string') return null;

    const text = raw.trim().toLowerCase();

    // Try explicit date first
    const explicit = new Date(raw);
    if (!Number.isNaN(explicit.getTime())) return explicit.toISOString();

    // Handle relative strings like 2h, 3d, 1w, 4mo
    const match = text.match(/^(\d+)\s*(m|h|d|w|mo|y)$/i);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();

    const now = new Date();

    switch (unit) {
        case 'm':
            now.setMinutes(now.getMinutes() - value);
            break;
        case 'h':
            now.setHours(now.getHours() - value);
            break;
        case 'd':
            now.setDate(now.getDate() - value);
            break;
        case 'w':
            now.setDate(now.getDate() - value * 7);
            break;
        case 'mo':
            now.setMonth(now.getMonth() - value);
            break;
        case 'y':
            now.setFullYear(now.getFullYear() - value);
            break;
        default:
            return null;
    }

    return now.toISOString();
}

function dedupePosts(posts) {
    const seen = new Set();
    const result = [];

    for (const post of posts) {
        const key =
            post.postUrl ||
            `${post.authorName || 'unknown'}::${post.text || post.headline || ''}`;

        if (seen.has(key)) continue;
        seen.add(key);
        result.push(post);
    }

    return result;
}

const requests = profileUrls.map((profileUrl) => ({
    url: toRecentActivityUrl(profileUrl),
    userData: { sourceProfile: profileUrl },
}));

log.info(`Starting self-contained LinkedIn scrape for ${requests.length} profile(s).`);

const crawler = new PlaywrightCrawler({
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 90,
    maxRequestRetries: 1,

    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    preNavigationHooks: [
    async ({ page }, gotoOptions) => {
        gotoOptions.waitUntil = 'domcontentloaded';

        if (cookies.length > 0) {
            await page.context().addCookies(cookies);
        }
    }
],

    async requestHandler({ page, request }) {
        const { sourceProfile } = request.userData;

        await page.waitForTimeout(2500);

        let collected = [];

        for (let i = 0; i < maxScrolls; i++) {
            const posts = await page.evaluate(({ includeReposts }) => {
                const textOf = (el) => (el?.innerText || el?.textContent || '').trim();

                const cardSelector = [
                    'div.feed-shared-update-v2',
                    'article',
                    'div[data-id^="urn:li:activity"]',
                ].join(',');

                const cards = Array.from(document.querySelectorAll(cardSelector));

                const extracted = cards.map((card) => {
                    const authorName =
                        textOf(
                            card.querySelector(
                                '.update-components-actor__name, .feed-shared-actor__name, .update-components-actor__title'
                            )
                        ) || null;

                    const text =
                        textOf(
                            card.querySelector(
                                '.update-components-text, .feed-shared-inline-show-more-text, .break-words, [data-test-id="main-feed-activity-card__commentary"]'
                            )
                        ) || '';

                    const headline =
                        textOf(
                            card.querySelector(
                                '.update-components-text, .feed-shared-inline-show-more-text'
                            )
                        ) || text;

                    const timestampRaw =
                        textOf(
                            card.querySelector(
                                '.update-components-actor__sub-description span[aria-hidden="true"], .feed-shared-actor__sub-description span[aria-hidden="true"], time'
                            )
                        ) || null;

                    const postAnchor = card.querySelector(
                        'a.app-aware-link[href*="/posts/"], a.app-aware-link[href*="/feed/update/"]'
                    );
                    const postUrl = postAnchor?.getAttribute('href') || null;

                    const imageEl = card.querySelector('img');
                    const imageUrl = imageEl?.getAttribute('src') || null;

                    const fullText = card.innerText || '';
                    const isRepost =
                        /reposted this|shared this|repost/i.test(fullText);

                    return {
                        authorName,
                        text,
                        headline,
                        timestampRaw,
                        postUrl,
                        imageUrl,
                        isRepost,
                    };
                });

                return extracted.filter((item) => {
                    if (!includeReposts && item.isRepost) return false;
                    return Boolean(item.text || item.headline || item.postUrl);
                });
            }, { includeReposts });

            collected = dedupePosts([...collected, ...posts]);

            if (debug) {
                log.info(`Collected ${collected.length} raw post(s) so far`, {
                    profile: sourceProfile,
                    scrollIndex: i + 1,
                });
            }

            if (collected.length >= maxPostsPerProfile) break;

            await page.mouse.wheel(0, 5000);
            await page.waitForTimeout(2000);
        }

        const normalized = dedupePosts(
            collected.slice(0, maxPostsPerProfile).map((item) => ({
                sourceProfile,
                authorName: item.authorName,
                authorUrl: sourceProfile,
                text: item.text || '',
                headline: item.headline || item.text || '',
                postUrl: normalizeUrl(item.postUrl),
                postType: 'post',
                timestamp: parseRelativeTimestamp(item.timestampRaw),
                rawTimestamp: item.timestampRaw,
                imageUrl: item.imageUrl,
                raw: item,
            }))
        );

        if (debug) {
            log.info(`Pushing ${normalized.length} normalized post(s)`, {
                profile: sourceProfile,
            });
        }

        if (normalized.length > 0) {
            await Actor.pushData(normalized);
        }
    },
});

await crawler.run(requests);

await Actor.exit();
