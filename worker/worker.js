// Hosted transport for the Rust/WASM frontend on GitHub Pages.

const KRMZI_ORIGIN = 'https://krmzi.org';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://xrtm8.github.io',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

const krmziHost = host => /^(?:www\.)?krmzi\.(?:org|net|tv)$/.test(host);
const okHost = host => host === 'ok.ru' || host === 'www.ok.ru';
const mediaHost = host => /(?:^|\.)(?:okcdn\.ru|vkuser\.net)$/.test(host);

function allowedUrl(raw, checkHost) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && checkHost(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

async function fetchAllowed(url, checkHost, headers = {}, signal = AbortSignal.timeout(9000)) {
  for (let attempt = 0; url && attempt < 5; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    url = location && allowedUrl(new URL(location, url), checkHost);
  }
  throw new Error('Unsupported upstream redirect');
}

async function krmziHtml(raw) {
  const response = await fetchAllowed(allowedUrl(raw, krmziHost), krmziHost);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Krmzi upstream unavailable');
  }
  return response.text();
}

function proxyPlaylist(body, base, origin) {
  const proxied = value => {
    const url = allowedUrl(new URL(value, base), mediaHost);
    if (!url) throw new Error('Unsupported playlist URL');
    return `${origin}/api/media?url=${encodeURIComponent(url.href)}`;
  };
  return body.split('\n').map(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#')
      ? proxied(trimmed)
      : line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxied(uri)}"`);
  }).join('\n');
}

function decodeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(text) {
  if (!text) return '';
  return decodeHtml(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanTitle(text) {
  return stripTags(text).replace(/\s*-\s*قرمزي\s*$/, '').trim();
}

function extractRealUrl(raw) {
  if (!raw) return '';
  raw = decodeHtml(raw);
  if (raw.includes('krmzi.org') || raw.includes('krmzi.net') || raw.includes('krmzi.tv')) {
    if (!raw.includes('sayyarh.com') && !raw.includes('?url=') && !raw.includes('&url=')) {
      return raw;
    }
  }
  try {
    const u = new URL(raw);
    for (const param of ['url', 'link', 'target']) {
      const val = u.searchParams.get(param);
      if (val) {
        if (val.startsWith('http')) return val;
        try {
          const decoded = atob(val);
          if (decoded.includes('krmzi.')) return decoded;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return raw;
}

function parseCards(html, kind) {
  const blocks = html.match(/<div\s+class=["']block-post["']>[\s\S]*?<\/div>\s*<\/div>/g) || [];
  const results = [];
  const seen = new Set();

  for (const block of blocks) {
    const linkMatches = [...block.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["']/g)];
    let targetLink = null;
    let targetTitle = '';

    for (const m of linkMatches) {
      const realUrl = extractRealUrl(m[1]);
      if (realUrl.includes('krmzi.')) {
        if (kind === 'series' && !realUrl.includes('/series/')) continue;
        if (kind === 'search' && !realUrl.includes('/series/') && !realUrl.includes('/episode/')) continue;
        targetLink = realUrl;
        targetTitle = cleanTitle(m[2]);
        break;
      }
    }

    if (!targetLink || seen.has(targetLink)) continue;
    seen.add(targetLink);

    const thumbMatch = block.match(/url\(['"]?(https:\/\/krmzi\.org\/wp-content\/uploads\/[^)'"\s]+)['"]?\)/);
    const thumbnail = thumbMatch ? decodeHtml(thumbMatch[1]) : '';

    const numMatch = block.match(/<div\s+class=["']episodeNum["']>[\s\S]*?<span>(\d+)<\/span>/);
    const episodeNum = numMatch ? numMatch[1] : '';

    const seriesTitle = targetTitle.replace(/الحلقة\s*\d+.*/, '').trim();
    const mediaType = (kind === 'series' || targetLink.includes('/series/')) ? 'series' : 'episode';
    const isDubbed = block.includes('مدبلج') || targetLink.includes('dubbed') || targetTitle.includes('مدبلج');

    results.push({
      url: targetLink,
      title: targetTitle,
      thumbnail: thumbnail,
      source: 'krmzi',
      type: mediaType,
      seriesTitle: seriesTitle,
      episodeNum: episodeNum,
      edition: isDubbed ? 'dubbed' : 'original',
    });
  }
  return results;
}

function hasNextPage(html, page, isSeries) {
  const marker = isSeries ? `series-list/page/${page + 1}/` : `page/${page + 1}/`;
  return html.includes(marker) ||
         new RegExp(`[?&](?:amp;)?paged=${page + 1}([&#"']|$)`).test(html) ||
         /class=["'][^"']*\bnext\b[^"']*["']/.test(html);
}

function parseSeriesDetail(html, url) {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1Match ? cleanTitle(h1Match[1]) : '';
  const storyMatch = html.match(/<div\s+class=["'](?:story|desc)["']>([\s\S]*?)<\/div>/);
  const story = storyMatch ? stripTags(storyMatch[1]) : '';

  const posterMatch = html.match(/url\(['"]?(https:\/\/krmzi\.org\/wp-content\/uploads\/[^)'"\s]+)['"]?\)/) ||
                      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/);
  const poster = posterMatch ? decodeHtml(posterMatch[1]) : '';

  const isDubbed = html.includes('مدبلج') || url.includes('dubbed') || title.includes('مدبلج');
  const edition = isDubbed ? 'dubbed' : 'original';

  const anchorMatches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g)];
  const seen = new Set();
  const episodes = [];

  for (const m of anchorMatches) {
    const link = extractRealUrl(m[1]);
    if (!link.includes('/episode/') || !link.includes('krmzi.') || seen.has(link)) continue;
    seen.add(link);

    const epTitle = stripTags(m[2]);
    let epNum = '';
    try {
      const numInPath = decodeURIComponent(link).match(/الحلقة[-\s]*(\d+)/);
      if (numInPath) {
        epNum = numInPath[1];
      }
    } catch (_) {}
    if (!epNum) {
      const numInTitle = epTitle.match(/(\d+)/);
      if (numInTitle) epNum = numInTitle[1];
    }

    episodes.push({
      url: link,
      title: epTitle || (epNum ? `الحلقة ${epNum}` : 'حلقة'),
      seriesTitle: title,
      episodeNum: epNum,
      source: 'krmzi',
      seriesUrl: url,
      edition: edition,
    });
  }

  episodes.sort((a, b) => (parseInt(a.episodeNum, 10) || 0) - (parseInt(b.episodeNum, 10) || 0));

  return {
    url,
    title,
    poster,
    story,
    episodes,
    source: 'krmzi',
    edition,
    isSuccess: true,
  };
}

function embedUrl(name, id) {
  const lower = (name || '').toLowerCase();
  if (lower === 'ok' || lower === 'ok.ru' || (lower.includes('ok') && !lower.includes('box'))) {
    const clean = id.replace(/^https?:\/\/ok\.ru\/videoembed\//, '').replace(/\/+$/, '');
    return `https://ok.ru/videoembed/${clean}`;
  }
  switch (lower) {
    case 'arab hd': return `https://arabhd.onl/embed-${id}.html`;
    case 'estream': return `https://arabveturk.com/embed-${id}.html`;
    case 'red hd': return `https://iplayerhls.com/e/${id}`;
    case 'box': return `https://youdboox.com/embed-${id}.html`;
    case 'now': return `https://extreamnow.org/embed-${id}.html`;
    case 'pro hd': return `https://embedo.co/e/${id}`;
    case 'dailymotion': return `https://www.dailymotion.com/embed/video/${id}`;
    case 'youtube': return `https://www.youtube.com/embed/${id}`;
    default:
      if (id.startsWith('http://') || id.startsWith('https://')) return id;
      return '';
  }
}

async function fetchOkStreams(id) {
  const cleanId = id.replace(/^https?:\/\/ok\.ru\/videoembed\//, '').replace(/\/+$/, '').trim();
  if (!/^\d+$/.test(cleanId)) return [];

  try {
    const resp = await fetchAllowed(new URL(`https://ok.ru/videoembed/${cleanId}`), okHost, {
      Origin: 'https://ok.ru',
      Referer: 'https://ok.ru/',
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const dataOptionsMatch = html.match(/data-options="([^"]+)"/);
    if (!dataOptionsMatch) return [];

    const decoded = decodeHtml(dataOptionsMatch[1]);
    const options = JSON.parse(decoded);
    let metadata = options?.flashvars?.metadata;
    if (typeof metadata === 'string') {
      metadata = JSON.parse(metadata);
    }
    if (!metadata) return [];

    const streams = [];
    const seen = new Set();

    if (allowedUrl(metadata.hlsManifestUrl, mediaHost)) {
      streams.push({ quality: 'تلقائي', type: 'hls', url: metadata.hlsManifestUrl });
      seen.add(metadata.hlsManifestUrl);
    }

    const qualityMap = [
      ['full', '1080p (Full HD)'],
      ['hd', '720p (HD)'],
      ['sd', '480p (SD)'],
      ['low', '360p'],
      ['lowest', '240p'],
      ['mobile', '144p'],
    ];

    if (Array.isArray(metadata.videos)) {
      for (const [key, label] of qualityMap) {
        const item = metadata.videos.find(v => v.name === key);
        if (item && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          streams.push({ quality: label, url: item.url });
        }
      }
    }
    return streams;
  } catch (_) {
    return [];
  }
}

async function parseEpisodeDetail(html, url, selectedServer) {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  let title = h1Match ? cleanTitle(h1Match[1]) : '';
  if (!title) {
    const titleTag = html.match(/<title>([\s\S]*?)<\/title>/);
    title = titleTag ? cleanTitle(titleTag[1]) : '';
  }

  let episodeNum = '';
  try {
    const decodedUrl = decodeURIComponent(url);
    const epMatch = (`${decodedUrl} ${title}`).match(/الحلقة[-\s]*(\d+)/);
    if (epMatch) episodeNum = epMatch[1];
  } catch (_) {}

  const seriesMatch = html.match(/<a[^>]+href=["'](https:\/\/krmzi\.org\/series\/[^"']+)["']/);
  const seriesUrl = seriesMatch ? decodeHtml(seriesMatch[1]) : '';

  const seriesTitle = title.replace(/الحلقة[-\s]*\d+.*/, '').trim() || title;

  const isDubbed = html.includes('مدبلج') || url.includes('dubbed') || title.includes('مدبلج');
  const edition = isDubbed ? 'dubbed' : 'original';

  const posterMatch = html.match(/url\(['"]?(https:\/\/krmzi\.org\/wp-content\/uploads\/[^)'"\s]+)['"]?\)/) ||
                      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/);
  const poster = posterMatch ? decodeHtml(posterMatch[1]) : '';

  let rawServers = [];
  const qesenMatch = html.match(/href=["']https:\/\/qesen\.net\/krmzi\?post=([^"']+)["']/);
  if (qesenMatch) {
    try {
      const qesenJson = JSON.parse(atob(qesenMatch[1]));
      if (Array.isArray(qesenJson.servers)) {
        rawServers = qesenJson.servers;
      }
    } catch (_) {}
  }

  if (rawServers.length === 0) {
    const liMatches = [...html.matchAll(/<li[^>]*data-name=["']([^"']*)["'][^>]*data-server=["']([^"']*)["']/g)];
    for (const m of liMatches) {
      rawServers.push({ name: decodeHtml(m[1]), id: decodeHtml(m[2]) });
    }
  }

  if (rawServers.length === 0) {
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/);
    if (iframeMatch) {
      rawServers.push({ name: 'سيرفر رئيسي', id: decodeHtml(iframeMatch[1]) });
    }
  }

  const servers = [];
  const seen = new Set();
  for (const s of rawServers) {
    const name = String(s.name || '').trim();
    const id = String(s.id || '').trim();
    const pair = `${name}|${id}`;
    if (!id || seen.has(pair)) continue;
    seen.add(pair);
    const embed = embedUrl(name, id);
    if (!embed) continue;
    servers.push({ name, id, embedUrl: embed, hasDirectStream: false });
  }

  let directStreams = [];
  const isOk = (s) => {
    const n = s.name.toLowerCase();
    const id = s.id;
    return n.includes('ok') || id.includes('ok.ru') || (/^\d{8,}$/.test(id));
  };

  const okCandidates = servers.filter(isOk);
  for (const candidate of okCandidates) {
    if (selectedServer && candidate.id !== selectedServer) continue;
    const streams = await fetchOkStreams(candidate.id);
    if (streams && streams.length > 0) {
      directStreams = streams;
      candidate.hasDirectStream = true;
      break;
    }
  }

  servers.sort((a, b) => (b.hasDirectStream ? 1 : 0) - (a.hasDirectStream ? 1 : 0));

  return {
    url,
    title: episodeNum ? `الحلقة ${episodeNum}` : title,
    seriesTitle,
    episodeNum,
    poster,
    seriesUrl,
    servers,
    directStreams,
    source: 'krmzi',
    edition,
    isSuccess: true,
  };
}

function listingRoute(path, page, query) {
  const prefix = path === '/api/series' ? '/series-list/' : '/';
  const target = new URL(prefix + (page > 1 ? `page/${page}/` : ''), KRMZI_ORIGIN);
  if (query) target.searchParams.set('s', query);
  return target;
}

async function listing(path, page, query = '') {
  const kind = path.slice(5);
  const key = kind === 'search' ? 'results' : kind;
  const html = await krmziHtml(listingRoute(path, page, query));
  const hasNext = hasNextPage(html, page, kind === 'series');
  return { page, [key]: parseCards(html, kind), hasNext, nextPage: hasNext ? page + 1 : null, isSuccess: true };
}

async function media(request, url) {
  const target = allowedUrl(url.searchParams.get('url'), mediaHost);
  if (!target) return jsonResponse({ error: 'Unsupported media URL' }, 400);

  const referrer = /(?:^|\.)okcdn\.ru$/.test(target.hostname) ? 'https://ok.ru' : 'https://vk.com';
  const upstreamHeaders = { Origin: referrer, Referer: referrer + '/' };
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.Range = range;

  const response = await fetchAllowed(target, mediaHost, upstreamHeaders);
  const contentType = response.headers.get('Content-Type') || '';
  if (response.ok && (target.pathname.endsWith('.m3u8') || /mpegurl/i.test(contentType))) {
    const body = proxyPlaylist(await response.text(), response.url || target, url.origin);
    return new Response(body, {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }
    });
  }
  const headers = new Headers(CORS_HEADERS);
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    const path = url.pathname;
    const page = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('page'), 10) || 1));

    try {
      switch (path) {
        case '/api/health':
          return jsonResponse({ ok: true, service: 'ZOET Web Gateway' });
        case '/api/series':
        case '/api/episodes':
          return jsonResponse(await listing(path, page), 200, 120);
        case '/api/home': {
          const [series, episodes] = await Promise.all([listing('/api/series', page), listing('/api/episodes', page)]);
          return jsonResponse({ series, episodes, isSuccess: true }, 200, 120);
        }
        case '/api/search': {
          const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
          if (!query) return jsonResponse({ query, page, results: [], hasNext: false, nextPage: null });
          return jsonResponse({ query, ...await listing(path, page, query) }, 200, 60);
        }
        case '/api/series/detail':
        case '/api/episode/detail': {
          const kind = path.split('/')[2];
          const target = allowedUrl(url.searchParams.get('url'), krmziHost);
          if (!target?.pathname.startsWith(`/${kind}/`)) {
            return jsonResponse({ error: 'Unsupported Krmzi URL' }, 400);
          }
          const html = await krmziHtml(target);
          const detail = kind === 'series'
            ? parseSeriesDetail(html, target.href)
            : await parseEpisodeDetail(html, target.href, url.searchParams.get('server') || '');
          return jsonResponse(detail, 200, kind === 'series' ? 120 : 0);
        }
        case '/api/media':
          return await media(request, url);
        default:
          return jsonResponse({ error: 'Unknown route' }, 404);
      }
    } catch {
      return jsonResponse({ error: 'Upstream unavailable', isSuccess: false }, 502);
    }
  }
};
