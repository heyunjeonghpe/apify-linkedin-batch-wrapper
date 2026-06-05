import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const {
    profileUrls = [],
    maxPostsPerProfile = 5,
    maxScrolls = 4,
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
        const parsed = typeof loginCookiesJson === 'string'
            ? JSON.parse(loginCookiesJson)
            : loginCookiesJson;

        cookies = parsed
            .filter((c) => ['li_at', 'JSESSIONID', 'bcookie', 'lidc'].includes(c.name))
            .map((cookie) => {
                const normalized = {
                    name: cookie.name,
                    value: cookie.value,
                    domain: '.linkedin.com',
                    path: cookie.path || '/',
                    secure: Boolean(cookie.secure),
                    httpOnly: Boolean(cookie.httpOnly),
                };

                if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
                    normalized.sameSite = cookie.sameSite;
                }

                return normalized;
            });
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

    const explicit = new Date(raw);
    if (!Number.isNaN(explicit.getTime())) return explicit.toISOString();

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

// ***** IMPORTANT: use Apify Residential Proxy *****
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 1,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 240,
    navigationTimeoutSecs: 120,

    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 20,
    },

    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    preNavigationHooks: [
        async ({ page, session }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';

            // add cookies before navigation
            if (cookies.length > 0) {
                await page.context().addCookies(cookies);
            }

            await page.setExtraHTTPHeaders({
                'accept-language': 'en-US,en;q=0.9',
                'upgrade-insecure-requests': '1',
            });

            if (debug) {
                log.info('Prepared page before navigation', {
                    sessionId: session?.id,
                    cookieCount: cookies.length,
                });
            }
        },
    ],

    async requestHandler({ page, request, session }) {
        const { sourceProfile } = request.userData;

        // give the page time to settle
        await page.waitForTimeout(5000);

        // If LinkedIn redirected to login/checkpoint, don't proceed
        const currentUrl = page.url();
        if (
            currentUrl.includes('/login') ||
            currentUrl.includes('/checkpoint/') ||
            currentUrl.includes('/authwall')
        ) {
            throw new Error(`LinkedIn redirected to auth/checkpoint for ${sourceProfile}: ${currentUrl}`);
        }

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
