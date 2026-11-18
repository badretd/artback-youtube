import { config } from './config.js';
import { httpError } from './util.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3/';

function youtubeError(data, status) {
  const error = data?.error;
  const reason = error?.errors?.[0]?.reason || error?.status;
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return httpError(
      429,
      'Дневная квота YouTube API исчерпана. Попробуйте позже или увеличьте квоту в Google Cloud.',
      'YT_QUOTA',
    );
  }
  if (reason === 'keyInvalid' || reason === 'badRequest') {
    return httpError(502, 'YouTube API отклонил ключ. Проверьте YOUTUBE_API_KEY.', 'YT_KEY_INVALID');
  }
  if (reason === 'rateLimitExceeded') {
    return httpError(429, 'YouTube API временно ограничил запросы. Повторите через минуту.', 'YT_RATE');
  }
  return httpError(
    502,
    `Ошибка YouTube API: ${error?.message || `HTTP ${status}`}`,
    'YT_ERROR',
  );
}

async function ytGet(path, params = {}, accessToken = null) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    if (!config.youtubeApiKey) {
      throw httpError(503, 'YouTube API не настроен: добавьте YOUTUBE_API_KEY.', 'YT_NOT_CONFIGURED');
    }
    url.searchParams.set('key', config.youtubeApiKey);
  }

  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw httpError(502, `Не удалось связаться с YouTube API: ${error.message}`, 'YT_NETWORK');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw youtubeError(data, response.status);
  return data;
}

function mapChannel(item) {
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const hidden = stats.hiddenSubscriberCount === true;
  const subscriberCount = hidden ? null : Number.parseInt(stats.subscriberCount ?? '0', 10) || 0;
  const handle = snippet.customUrl || null;
  return {
    id: item.id,
    title: snippet.title || 'YouTube-канал',
    description: snippet.description || '',
    handle,
    avatarUrl:
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      null,
    subscriberCount,
    hiddenSubscribers: hidden,
    channelUrl: `https://www.youtube.com/channel/${item.id}`,
    publishedAt: snippet.publishedAt || null,
  };
}

function normalizeHandle(value) {
  const handle = String(value).trim();
  return handle.startsWith('@') ? handle : `@${handle}`;
}

export function parseChannelInput(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) throw httpError(400, 'Укажите ссылку на канал или @ник', 'CHANNEL_INPUT');

  if (/^UC[\w-]{22}$/.test(input)) return { id: input };

  const channelMatch = input.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
  if (channelMatch) return { id: channelMatch[1] };

  const handleMatch = input.match(/youtube\.com\/@([^/?#\s]+)/i);
  if (handleMatch) return { forHandle: `@${handleMatch[1]}` };

  if (/^@[^/?#\s]+$/i.test(input)) return { forHandle: input };

  const legacyMatch = input.match(/youtube\.com\/(?:c|user)\/([^/?#\s]+)/i);
  if (legacyMatch) return { forUsername: legacyMatch[1], search: legacyMatch[1] };

  if (/^[^\s/?#]+$/.test(input) && input.length <= 80) {
    return { forHandle: normalizeHandle(input), forUsername: input, search: input };
  }

  return { search: input };
}

export async function fetchChannelById(channelId) {
  const data = await ytGet('channels', {
    part: 'snippet,statistics',
    id: channelId,
    maxResults: 1,
  });
  const item = data.items?.[0];
  return item ? mapChannel(item) : null;
}

export async function resolveChannel(rawInput) {
  const parsed = parseChannelInput(rawInput);

  if (parsed.id) {
    const channel = await fetchChannelById(parsed.id);
    if (channel) return channel;
  }

  if (parsed.forHandle) {
    const data = await ytGet('channels', {
      part: 'snippet,statistics',
      forHandle: parsed.forHandle,
      maxResults: 1,
    });
    if (data.items?.[0]) return mapChannel(data.items[0]);
  }

  if (parsed.forUsername) {
    const data = await ytGet('channels', {
      part: 'snippet,statistics',
      forUsername: parsed.forUsername,
      maxResults: 1,
    });
    if (data.items?.[0]) return mapChannel(data.items[0]);
  }

  if (parsed.search) {
    // search.list стоит 100 единиц квоты, поэтому используем только как fallback.
    const search = await ytGet('search', {
      part: 'snippet',
      type: 'channel',
      q: parsed.search,
      maxResults: 1,
    });
    const channelId = search.items?.[0]?.id?.channelId;
    if (channelId) {
      const channel = await fetchChannelById(channelId);
      if (channel) return channel;
    }
  }

  throw httpError(404, 'Канал не найден. Проверьте ссылку или @ник.', 'CHANNEL_NOT_FOUND');
}

export async function fetchChannelsByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const channels = [];
  let requests = 0;

  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50);
    const data = await ytGet('channels', {
      part: 'snippet,statistics',
      id: chunk.join(','),
      maxResults: 50,
    });
    requests += 1;
    for (const item of data.items || []) channels.push(mapChannel(item));
  }

  return { channels, requests };
}

export async function getMyChannel(accessToken) {
  const data = await ytGet(
    'channels',
    { part: 'snippet,statistics', mine: 'true', maxResults: 1 },
    accessToken,
  );
  const item = data.items?.[0];
  return item ? mapChannel(item) : null;
}

export function channelDescriptionHasCode(channel, code) {
  return String(channel?.description || '').includes(code);
}
