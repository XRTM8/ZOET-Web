/**
 * ZOET Web - Cloudflare Worker CORS & API Gateway
 *
 * This Worker bridges ZOET Web (running on GitHub Pages) with upstream media APIs,
 * bypassing browser CORS restrictions and setting the required headers.
 * 
 * Free deployment:
 * 1. Sign up for free at https://cloudflare.com
 * 2. Workers & Pages -> Create Application -> Create Worker
 * 3. Paste this code and click 'Save and Deploy'
 * 4. Copy your Worker URL (e.g. https://zoet-api.yourname.workers.dev)
 * 5. Paste it into ZOET Web Server Settings!
 */

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

export default {
  async fetch(request) {
    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/api/health' || path === '/health') {
      return jsonResponse({
        ok: true,
        service: 'ZOET Cloudflare Worker Gateway',
        version: '2.8.0',
        timestamp: new Date().toISOString(),
      });
    }

    // Cinemana API & subtitle proxy
    if (path.startsWith('/api/cinemana/subtitle')) {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return jsonResponse({ error: 'Missing url parameter' }, 400);
      }
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

    if (path.startsWith('/api/cinemana')) {
      const cinemanaPath = url.searchParams.get('path');
      if (!cinemanaPath) {
        return jsonResponse({ error: 'Missing path parameter' }, 400);
      }

      const targetUrl = CINEMANA_BASE + cinemanaPath;
      try {
        const resp = await fetch(targetUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
          },
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

    // Media stream proxy (for CORS or Referer-protected streams like OK.ru / VK)
    if (path.startsWith('/api/proxy') || path.startsWith('/api/media')) {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return jsonResponse({ error: 'Missing url parameter' }, 400);
      }

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
        if (range) {
          upstreamHeaders.set('Range', range);
        }

        const resp = await fetch(targetUrl, {
          headers: upstreamHeaders,
        });

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

    // Fallback for root or unknown routes
    return jsonResponse({
      name: 'ZOET API Gateway',
      status: 'active',
      endpoints: ['/api/health', '/api/cinemana', '/api/proxy'],
    });
  },
};
