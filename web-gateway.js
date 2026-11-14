// ZOET Web API Interceptor, Gateway Router & Web Settings Controller
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const qApi = urlParams.get('api');
  if (qApi) {
    localStorage.setItem('zoet_backend_url', qApi.replace(/\/+$/, ''));
  }

  // Always keep 'all' as the default source view; reset previous auto-forced cinemana once
  if (!localStorage.getItem('zoet_web_source_v2')) {
    if (!localStorage.getItem('zoet_backend_url') && localStorage.getItem('zoet_source') === 'cinemana') {
      localStorage.setItem('zoet_source', 'all');
      localStorage.setItem('otium_source', 'all');
    }
    localStorage.setItem('zoet_web_source_v2', '1');
  }

  const originalFetch = window.fetch;
  const nativeSetAttr = Element.prototype.setAttribute;
  const trackSrcDesc = typeof HTMLTrackElement !== 'undefined'
    ? Object.getOwnPropertyDescriptor(HTMLTrackElement.prototype, 'src')
    : null;
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

    const backend = localStorage.getItem('zoet_backend_url') || window.ZOET_BACKEND_URL || '';
    const fetchTarget = backend
      ? backend.replace(/\/+$/, '') + '/api/cinemana/subtitle' + parsed.search
      : subUrl;

    originalFetch.call(window, fetchTarget, { method: 'GET' })
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
    if (this.tagName === 'TRACK' && String(name).toLowerCase() === 'src' && typeof value === 'string') {
      if (hydrateSubtitleTrack(this, value)) return;
    }
    return nativeSetAttr.call(this, name, value);
  };

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
      if (typeof url === 'string' && url.startsWith('/api/')) {
        const backend = localStorage.getItem('zoet_backend_url') || window.ZOET_BACKEND_URL || '';
        if (backend) {
          target = backend.replace(/\/+$/, '') + url;
        }
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

    const backend = localStorage.getItem('zoet_backend_url') || window.ZOET_BACKEND_URL || '';
    const apiIdx = parsed.pathname.indexOf('/api/');
    const apiSubpath = parsed.pathname.substring(apiIdx + 5);

    if (backend) {
      const targetUrl = backend.replace(/\/+$/, '') + '/api/' + apiSubpath + parsed.search;
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

    if (apiSubpath.startsWith('home')) {
      return Promise.resolve(new Response(JSON.stringify({
        series: { series: [], hasNext: false, page: 1 },
        episodes: { episodes: [], hasNext: false, page: 1 },
        status: true,
        isSuccess: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }));
    }

    if (apiSubpath.startsWith('series') || apiSubpath.startsWith('episodes') || apiSubpath.startsWith('search')) {
      return Promise.resolve(new Response(JSON.stringify({
        series: [],
        episodes: [],
        results: [],
        hasNext: false,
        page: 1,
        status: true,
        isSuccess: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }));
    }

    if (apiSubpath.startsWith('series/detail') || apiSubpath.startsWith('episode/detail')) {
      return Promise.resolve(new Response(JSON.stringify({
        status: false,
        error: 'يتطلب قرمزي خادم اتصال (Backend URL)',
        isSuccess: false
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }));
    }

    return originalFetch.call(this, resource, init);
  };

  function showWebToast(msg) {
    const t = document.getElementById('appToast');
    if (t) {
      t.textContent = msg;
      t.classList.remove('hidden');
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
    }
  }

  function initWebGatewaySettings() {
    const serverRow = document.getElementById('webServerSettingsRow');
    const serverUrlInput = document.getElementById('serverUrlInput');
    const saveServerBtn = document.getElementById('saveServerBtn');
    const testServerBtn = document.getElementById('testServerBtn');
    const serverStatusMsg = document.getElementById('serverStatusMsg');

    if (serverRow) {
      serverRow.classList.remove('hidden');
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
    if (serverUrlInput) {
      serverUrlInput.value = localStorage.getItem('zoet_backend_url') || '';
    }

    const setStatus = (msg, kind) => {
      if (!serverStatusMsg) return;
      serverStatusMsg.textContent = msg;
      serverStatusMsg.classList.remove('is-ok', 'is-err');
      if (kind === 'ok') serverStatusMsg.classList.add('is-ok');
      if (kind === 'err') serverStatusMsg.classList.add('is-err');
    };

    if (saveServerBtn && serverUrlInput) {
      saveServerBtn.addEventListener('click', () => {
        const val = serverUrlInput.value.trim().replace(/\/+$/, '');
        if (val) {
          localStorage.setItem('zoet_backend_url', val);
        } else {
          localStorage.removeItem('zoet_backend_url');
        }
        setStatus('تم حفظ إعدادات الخادم بنجاح، جاري التحديث...', 'ok');
        setTimeout(() => window.location.reload(), 600);
      });
    }

    if (testServerBtn && serverUrlInput) {
      testServerBtn.addEventListener('click', async () => {
        const val = serverUrlInput.value.trim().replace(/\/+$/, '');
        if (!val) {
          setStatus('يرجى إدخال رابط الخادم أولاً.', 'err');
          return;
        }
        setStatus('جاري فحص الاتصال بالخادم...', '');
        try {
          const resp = await originalFetch.call(window, val + '/api/health');
          if (resp.ok) {
            setStatus('الخادم متصل ويعمل بنجاح.', 'ok');
          } else {
            setStatus('استجاب الخادم برمز خطأ (' + resp.status + ').', 'err');
          }
        } catch (e) {
          setStatus('تعذّر الاتصال بالخادم. تحقق من الرابط وإعدادات CORS.', 'err');
        }
      });
    }

    document.addEventListener('click', (e) => {
      const krmziBtn = e.target.closest('[data-source="krmzi"], [data-pref-source="krmzi"]');
      if (krmziBtn && !localStorage.getItem('zoet_backend_url')) {
        showWebToast('لتشغيل قرمزي على الويب: فعّل خادم ZOET المحلي (127.0.0.1:3000) أو أدخل رابط Cloudflare Worker من الإعدادات.');
      }
    });

    autoDetectLocalBackend();
  }

  function autoDetectLocalBackend() {
    if (localStorage.getItem('zoet_backend_url')) return;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = setTimeout(() => { if (controller) controller.abort(); }, 1200);
      originalFetch.call(window, 'http://127.0.0.1:3000/api/health', {
        method: 'GET',
        signal: controller ? controller.signal : undefined
      }).then(r => {
        clearTimeout(timeout);
        if (r && r.ok) {
          localStorage.setItem('zoet_backend_url', 'http://127.0.0.1:3000');
          showWebToast('تم الاتصال تلقائياً بخادم ZOET المحلي (127.0.0.1:3000)');
          const serverUrlInput = document.getElementById('serverUrlInput');
          if (serverUrlInput) serverUrlInput.value = 'http://127.0.0.1:3000';
          const currentSource = localStorage.getItem('zoet_source') || localStorage.getItem('otium_source');
          if (currentSource === 'krmzi') {
            setTimeout(() => window.location.reload(), 300);
          }
        }
      }).catch(() => {
        clearTimeout(timeout);
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWebGatewaySettings);
  } else {
    initWebGatewaySettings();
  }
})();
