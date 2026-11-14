// Browser routing for the hosted Krmzi API and the direct Cinemana provider.
(function() {
  const originalFetch = window.fetch;
  const backend = document.querySelector('meta[name="zoet-api-origin"]')?.content.replace(/\/+$/, '') || '';
  // Recover visitors who last opened the unavailable source before this release.
  if (!backend && !localStorage.getItem('zoet_web_source_v4') && (localStorage.getItem('zoet_source') || localStorage.getItem('otium_source')) === 'krmzi') {
    localStorage.setItem('zoet_source', 'cinemana');
    localStorage.setItem('otium_source', 'cinemana');
    localStorage.setItem('zoet_web_source_v4', '1');
  }
  const nativeSetAttr = Element.prototype.setAttribute;
  const trackSrcDesc = typeof HTMLTrackElement !== 'undefined'
    ? Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'src')
    : null;
  const mediaSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  const trackBlobMap = new WeakMap();

  function toWebVtt(rawText) {
    const text = (rawText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!text) return '';
    if (/^WEBVTT(?:\s|$)/m.test(text.slice(0, 16))) return text;
    return 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2 --> $3.$4');
  }

  function hydrateSubtitleTrack(track, rawSrc) {
    if (!track || !rawSrc) return false;
    let parsed;
    try {
      parsed = new URL(rawSrc, window.location.href);
    } catch (e) {
      return false;
    }
    const isSameOrigin = parsed.origin === window.location.origin;
    if (!(isSameOrigin || rawSrc.startsWith('/api/')) || !parsed.pathname.includes('/api/cinemana/subtitle')) {
      return false;
    }
    const subUrl = parsed.searchParams.get('url');
    if (!subUrl) return true;

    const reqToken = String(Number(track.dataset.zoetSubSeq || '0') + 1);
    track.dataset.zoetSubSeq = reqToken;

    originalFetch.call(window, subUrl)
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(function(body) {
        if (track.dataset.zoetSubSeq !== reqToken) return;
        const vtt = toWebVtt(body);
        if (!vtt) return;
        const prev = trackBlobMap.get(track);
        if (prev) {
          try { URL.revokeObjectURL(prev); } catch (_) {}
        }
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt; charset=utf-8' }));
        trackBlobMap.set(track, blobUrl);
        nativeSetAttr.call(track, 'src', blobUrl);
        if (track.track && track.hasAttribute('default')) {
          track.track.mode = 'showing';
        }
      })
      .catch(function(err) {
        if (err && err.name !== 'AbortError') {
          console.warn('[ZOET Subtitle Fetch]:', subUrl, err);
        }
      });
    return true;
  }

  Element.prototype.setAttribute = function(name, value) {
    if (String(name).toLowerCase() === 'src' && typeof value === 'string') {
      if (this.tagName === 'TRACK' && hydrateSubtitleTrack(this, value)) return;
      if (backend && this.tagName === 'VIDEO' && value.startsWith('/api/media?')) value = backend + value;
    }
    return nativeSetAttr.call(this, name, value);
  };

  if (backend && mediaSrcDesc?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...mediaSrcDesc,
      set(value) {
        const target = typeof value === 'string' && value.startsWith('/api/media?') ? backend + value : value;
        mediaSrcDesc.set.call(this, target);
      }
    });
  }

  if (trackSrcDesc && trackSrcDesc.set) {
    Object.defineProperty(HTMLTrackElement.prototype, 'src', {
      configurable: true,
      enumerable: trackSrcDesc.enumerable,
      get: trackSrcDesc.get,
      set: function(value) {
        if (typeof value === 'string' && hydrateSubtitleTrack(this, value)) return;
        return trackSrcDesc.set.call(this, value);
      }
    });
  }

  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype.open) {
    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      let target = url;
      if (backend && typeof url === 'string' && url.startsWith('/api/')) {
        target = backend + url;
      }
      const args = Array.prototype.slice.call(arguments);
      args[1] = target;
      return origXhrOpen.apply(this, args);
    };
  }

  window.fetch = function(resource, init) {
    let rawUrl = '';
    let reqMethod = 'GET';
    const reqHeaders = {};
    let reqSignal = null;

    if (typeof resource === 'string') {
      rawUrl = resource;
      if (init) {
        reqMethod = init.method || 'GET';
        reqSignal = init.signal || null;
        if (init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => { reqHeaders[k] = v; });
          } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([k, v]) => { reqHeaders[k] = v; });
          } else {
            Object.assign(reqHeaders, init.headers);
          }
        }
      }
    } else if (resource && typeof resource === 'object') {
      rawUrl = resource.url || '';
      reqMethod = (init && init.method) || resource.method || 'GET';
      reqSignal = (init && init.signal) || resource.signal || null;
      if (init && init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { reqHeaders[k] = v; });
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([k, v]) => { reqHeaders[k] = v; });
        } else {
          Object.assign(reqHeaders, init.headers);
        }
      } else if (resource.headers) {
        try {
          resource.headers.forEach((v, k) => { reqHeaders[k] = v; });
        } catch (e) {
          Object.assign(reqHeaders, resource.headers);
        }
      }
    }

    let parsed;
    try {
      parsed = new URL(rawUrl, window.location.href);
    } catch (e) {
      return originalFetch.call(this, resource, init);
    }

    const isSameOrigin = parsed.origin === window.location.origin;
    const hasApiPath = parsed.pathname.includes('/api/');
    if (!hasApiPath || (!isSameOrigin && !rawUrl.startsWith('/api/'))) {
      return originalFetch.call(this, resource, init);
    }

    const apiIdx = parsed.pathname.indexOf('/api/');
    const apiSubpath = parsed.pathname.substring(apiIdx + 5);

    if (backend && !apiSubpath.startsWith('cinemana')) {
      const targetUrl = backend + '/api/' + apiSubpath + parsed.search;
      const forwardOptions = {
        method: reqMethod,
        headers: reqHeaders,
        signal: reqSignal
      };
      if (init && init.body) forwardOptions.body = init.body;
      return originalFetch.call(this, targetUrl, forwardOptions);
    }

    if (apiSubpath.startsWith('cinemana')) {
      if (apiSubpath.startsWith('cinemana/subtitle')) {
        const subUrl = parsed.searchParams.get('url');
        if (subUrl) {
          return originalFetch.call(this, subUrl, {
            method: 'GET',
            signal: reqSignal
          });
        }
      }

      const pathParam = parsed.searchParams.get('path');
      if (pathParam) {
        const cleanPath = pathParam.replace(/^\/+/, '');
        const targetUrl = 'https://cinemana.shabakaty.com/api/android/' + cleanPath;
        const headers = Object.assign({}, reqHeaders, {
          'Accept': 'application/json'
        });

        return originalFetch.call(this, targetUrl, {
          method: 'GET',
          headers: headers,
          signal: reqSignal
        }).catch(function(err) {
          if (!err || err.name !== 'AbortError') {
            console.error('[ZOET Cinemana Direct Fetch Error]:', targetUrl, err);
          }
          throw err;
        });
      }
    }

    if (/^(home|series|episodes|episode|search)(\/|$)/.test(apiSubpath)) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'قرمزي غير متاح حالياً', isSuccess: false }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }));
    }

    return originalFetch.call(this, resource, init);
  };

  function initWebGateway() {
    if (!backend) {
      const krmzi = document.querySelector('[data-source="krmzi"]');
      const notice = document.getElementById('krmziWebUnavailable');
      const updateNotice = () => notice.classList.toggle('hidden', krmzi.getAttribute('aria-pressed') !== 'true');
      new MutationObserver(updateNotice).observe(krmzi, { attributes: true, attributeFilter: ['aria-pressed'] });
      document.getElementById('tryCinemanaBtn').addEventListener('click', () => document.querySelector('[data-source="cinemana"]').click());
      updateNotice();
    }
    const nativePlayer = document.getElementById('nativePlayer');
    if (nativePlayer && 'MutationObserver' in window) {
      new MutationObserver((mutations) => {
        mutations.forEach((m) => {
          m.removedNodes.forEach((node) => {
            if (node && node.tagName === 'TRACK') {
              const prev = trackBlobMap.get(node);
              if (prev) {
                try { URL.revokeObjectURL(prev); } catch (_) {}
                trackBlobMap.delete(node);
              }
            }
          });
        });
      }).observe(nativePlayer, { childList: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWebGateway);
  } else {
    initWebGateway();
  }
})();
