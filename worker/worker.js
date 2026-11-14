/**
 * ZOET Web - Cloudflare Worker CORS & API Gateway v3.0.0
 *
 * This Worker bridges ZOET Web (running on GitHub Pages or locally) with upstream
 * media APIs (Cinemana & Krmzi), bypassing browser CORS restrictions and setting
 * the required headers and proxies.
 *
 * Free deployment:
 * 1. Sign up for free at https://cloudflare.com
 * 2. Workers & Pages -> Create Application -> Create Worker
 * 3. Paste this code and click 'Save and Deploy'
 * 4. Copy your Worker URL (e.g. https://zoet-api.yourname.workers.dev)
 * 5. Paste it into ZOET Web Server Settings or use ?api=https://...
 */

const KRMZI_ORIGIN = 'https://krmzi.org';
const CINEMANA_BASE = 'https://cinemana.shabakaty.com/api/android/';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
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
    const resp = await fetch(`https://ok.ru/videoembed/${cleanId}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Origin': 'https://ok.ru',
        'Referer': 'https://ok.ru/',
      },
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

    if (metadata.hlsManifestUrl && /^https?:\/\//.test(metadata.hlsManifestUrl)) {
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

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Health check
    if (path === '/api/health' || path === '/health') {
      return jsonResponse({
        ok: true,
        service: 'ZOET Cloudflare Worker Gateway',
        version: '3.0.0',
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Cinemana subtitle proxy
    if (path.startsWith('/api/cinemana/subtitle')) {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);
      try {
        const resp = await fetch(targetUrl, { headers: { 'User-Agent': USER_AGENT } });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      } catch (err) {
        return jsonResponse({ error: 'Subtitle fetch failed: ' + err.message }, 502);
      }
    }

    // 3. Cinemana API proxy
    if (path.startsWith('/api/cinemana')) {
      const cinemanaPath = url.searchParams.get('path');
      if (!cinemanaPath) return jsonResponse({ error: 'Missing path parameter' }, 400);
      try {
        const targetUrl = CINEMANA_BASE + cinemanaPath.replace(/^\/+/, '');
        const resp = await fetch(targetUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=120',
          },
        });
      } catch (err) {
        return jsonResponse({ error: 'Failed to contact Cinemana: ' + err.message }, 502);
      }
    }

    // 4. Krmzi Home
    if (path === '/api/home') {
      const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
      try {
        const epUrl = page === 1 ? `${KRMZI_ORIGIN}/` : `${KRMZI_ORIGIN}/page/${page}/`;
        const seriesUrl = page === 1 ? `${KRMZI_ORIGIN}/series-list/` : `${KRMZI_ORIGIN}/series-list/page/${page}/`;

        const [epResp, seriesResp] = await Promise.all([
          fetch(epUrl, { headers: { 'User-Agent': USER_AGENT } }).then(r => r.text()).catch(() => ''),
          fetch(seriesUrl, { headers: { 'User-Agent': USER_AGENT } }).then(r => r.text()).catch(() => ''),
        ]);

        const epCards = parseCards(epResp, 'episodes');
        const seriesCards = parseCards(seriesResp, 'series');

        return jsonResponse({
          episodes: {
            page,
            episodes: epCards,
            hasNext: hasNextPage(epResp, page, false),
            isSuccess: true,
          },
          series: {
            page,
            series: seriesCards,
            hasNext: hasNextPage(seriesResp, page, true),
            isSuccess: true,
          },
          isSuccess: true,
        });
      } catch (err) {
        return jsonResponse({ error: 'Failed to load home: ' + err.message, isSuccess: false }, 502);
      }
    }

    // 5. Krmzi Series List
    if (path === '/api/series') {
      const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
      try {
        const target = page === 1 ? `${KRMZI_ORIGIN}/series-list/` : `${KRMZI_ORIGIN}/series-list/page/${page}/`;
        const resp = await fetch(target, { headers: { 'User-Agent': USER_AGENT } });
        const html = await resp.text();
        const cards = parseCards(html, 'series');
        const hasNext = hasNextPage(html, page, true);

        return jsonResponse({
          page,
          series: cards,
          hasNext,
          nextPage: hasNext ? page + 1 : null,
          isSuccess: true,
        });
      } catch (err) {
        return jsonResponse({ error: 'Failed to load series: ' + err.message, isSuccess: false }, 502);
      }
    }

    // 6. Krmzi Episodes List
    if (path === '/api/episodes') {
      const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
      try {
        const target = page === 1 ? `${KRMZI_ORIGIN}/` : `${KRMZI_ORIGIN}/page/${page}/`;
        const resp = await fetch(target, { headers: { 'User-Agent': USER_AGENT } });
        const html = await resp.text();
        const cards = parseCards(html, 'episodes');
        const hasNext = hasNextPage(html, page, false);

        return jsonResponse({
          page,
          episodes: cards,
          hasNext,
          nextPage: hasNext ? page + 1 : null,
          isSuccess: true,
        });
      } catch (err) {
        return jsonResponse({ error: 'Failed to load episodes: ' + err.message, isSuccess: false }, 502);
      }
    }

    // 7. Krmzi Search
    if (path === '/api/search') {
      const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        return jsonResponse({ query: '', page, results: [], hasNext: false, nextPage: null, isSuccess: true });
      }
      try {
        const target = page === 1
          ? `${KRMZI_ORIGIN}/?s=${encodeURIComponent(q)}`
          : `${KRMZI_ORIGIN}/page/${page}/?s=${encodeURIComponent(q)}`;
        const resp = await fetch(target, { headers: { 'User-Agent': USER_AGENT } });
        const html = await resp.text();
        const results = parseCards(html, 'search');
        const hasNext = hasNextPage(html, page, false);

        return jsonResponse({
          query: q,
          page,
          results,
          hasNext,
          nextPage: hasNext ? page + 1 : null,
          isSuccess: true,
        });
      } catch (err) {
        return jsonResponse({ error: 'Search failed: ' + err.message, isSuccess: false }, 502);
      }
    }

    // 8. Krmzi Series Detail
    if (path === '/api/series/detail') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);
      try {
        const resp = await fetch(targetUrl, { headers: { 'User-Agent': USER_AGENT } });
        const html = await resp.text();
        const detail = parseSeriesDetail(html, targetUrl);
        return jsonResponse(detail);
      } catch (err) {
        return jsonResponse({ error: 'Failed to load series detail: ' + err.message, isSuccess: false }, 502);
      }
    }

    // 9. Krmzi Episode Detail
    if (path === '/api/episode/detail') {
      const targetUrl = url.searchParams.get('url');
      const selectedServer = url.searchParams.get('server') || '';
      if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);
      try {
        const resp = await fetch(targetUrl, { headers: { 'User-Agent': USER_AGENT } });
        const html = await resp.text();
        const detail = await parseEpisodeDetail(html, targetUrl, selectedServer);
        return jsonResponse(detail);
      } catch (err) {
        return jsonResponse({ error: 'Failed to load episode detail: ' + err.message, isSuccess: false }, 502);
      }
    }

    // 10. Media / Proxy streaming
    if (path.startsWith('/api/proxy') || path.startsWith('/api/media')) {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

      try {
        const upstreamHeaders = new Headers();
        upstreamHeaders.set('User-Agent', USER_AGENT);

        if (targetUrl.includes('ok.ru') || targetUrl.includes('odnoklassniki')) {
          upstreamHeaders.set('Origin', 'https://ok.ru');
          upstreamHeaders.set('Referer', 'https://ok.ru/');
        } else if (targetUrl.includes('vk.com') || targetUrl.includes('vkuser')) {
          upstreamHeaders.set('Origin', 'https://vk.com');
          upstreamHeaders.set('Referer', 'https://vk.com/');
        }

        const range = request.headers.get('Range');
        if (range) upstreamHeaders.set('Range', range);

        const resp = await fetch(targetUrl, { headers: upstreamHeaders });
        const responseHeaders = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) {
          responseHeaders.set(k, v);
        }

        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: responseHeaders,
        });
      } catch (err) {
        return jsonResponse({ error: 'Proxy failed: ' + err.message }, 502);
      }
    }

    // Fallback info
    return jsonResponse({
      name: 'ZOET API Gateway',
      status: 'active',
      version: '3.0.0',
      endpoints: [
        '/api/health',
        '/api/home',
        '/api/series',
        '/api/episodes',
        '/api/search',
        '/api/series/detail',
        '/api/episode/detail',
        '/api/cinemana',
        '/api/proxy',
      ],
    });
  },
};
