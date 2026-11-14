// ZOET Web API Interceptor, Gateway Router & Web Settings Controller
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const qApi = urlParams.get('api');
  if (qApi) {
    localStorage.setItem('zoet_backend_url', qApi.replace(/\/+$/, ''));
    const page = new URL(window.location.href);
    page.searchParams.delete('api');
    window.history.replaceState(null, '', page);
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
  const localBackend = 'http://127.0.0.1:3000';
  const savedBackend = (localStorage.getItem('zoet_backend_url') || window.ZOET_BACKEND_URL || '').replace(/\/+$/, '');
  const localConnectionHelp = 'شغّل خادم ZOET واسمح لهذا الموقع بالوصول للجهاز المحلي (Loopback network أو Local network) من إعدادات المتصفح، ثم حاول مرة ثانية.';
  let activeBackend = '';

  function isLoopback(address) {
    try {
      const host = new URL(address).hostname;
      return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
    } catch {
      return false;
    }
  }

  async function loopbackPermission() {
    try {
      return (await navigator.permissions.query({ name: 'loopback-network' })).state;
    } catch {
      return 'unknown';
    }
  }

  async function probeBackend(address, timeout) {
    const response = await originalFetch.call(window, `${address}/api/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout)
    });
    if (!response.ok || (await response.json()).ok !== true) {
      throw new Error('Invalid ZOET health response');
    }
  }

  const backendReady = (async () => {
    const address = savedBackend || localBackend;
    if (!isLoopback(address)) {
      activeBackend = address;
      return activeBackend;
    }
    const permission = await loopbackPermission();
    const verified = sessionStorage.getItem('zoet_verified_backend') === address;
    if (permission !== 'granted' && !(permission === 'unknown' && verified)) return '';
    try {
      await probeBackend(address, 2500);
      activeBackend = address;
    } catch {
      // Keep Cinemana on its direct route if the local server is unreachable.
    }
    return activeBackend;
  })();
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

    backendReady.then(backend => originalFetch.call(window,
      backend ? backend + '/api/cinemana/subtitle' + parsed.search : subUrl))
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
      if (activeBackend && typeof url === 'string' && url.startsWith('/api/')) {
        target = activeBackend + url;
      }
      const args = Array.prototype.slice.call(arguments);
      args[1] = target;
      return origXhrOpen.apply(this, args);
    };
  }

  window.fetch = async function(resource, init) {
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

    const backend = await backendReady;
    const apiIdx = parsed.pathname.indexOf('/api/');
    const apiSubpath = parsed.pathname.substring(apiIdx + 5);

    if (backend) {
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
      return new Response(JSON.stringify({ error: 'يتطلب قرمزي خادم اتصال', isSuccess: false }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return originalFetch.call(this, resource, init);
  };

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
    serverUrlInput.value = savedBackend;

    const setStatus = (msg, kind) => {
      if (!serverStatusMsg) return;
      serverStatusMsg.textContent = msg;
      serverStatusMsg.classList.remove('is-ok', 'is-err');
      if (kind === 'ok') serverStatusMsg.classList.add('is-ok');
      if (kind === 'err') serverStatusMsg.classList.add('is-err');
    };

    async function connect(address, button, report, save) {
      button.disabled = true;
      report('جاري فحص الاتصال بالخادم…');
      try {
        await probeBackend(address, 30000);
        report('الخادم متصل.', 'ok');
        if (save) {
          localStorage.setItem('zoet_backend_url', address);
          sessionStorage.setItem('zoet_verified_backend', address);
          window.location.reload();
        }
      } catch {
        report(isLoopback(address) ? localConnectionHelp : 'تعذّر الاتصال بخادم ZOET. تحقّق من الرابط.', 'err');
      } finally {
        button.disabled = false;
      }
    }

    const readAddress = () => serverUrlInput.value.trim().replace(/\/+$/, '');
    saveServerBtn.addEventListener('click', () => {
      const address = readAddress();
      if (address) {
        connect(address, saveServerBtn, setStatus, true);
      } else {
        localStorage.removeItem('zoet_backend_url');
        sessionStorage.removeItem('zoet_verified_backend');
        window.location.reload();
      }
    });
    testServerBtn.addEventListener('click', () => {
      connect(readAddress() || localBackend, testServerBtn, setStatus, false);
    });

    const notice = document.getElementById('krmziGatewayNotice');
    const connectBtn = document.getElementById('connectLocalBackend');
    const noticeStatus = document.getElementById('krmziGatewayStatus');
    const krmziBtn = document.querySelector('[data-source="krmzi"]');
    function updateNotice() {
      notice.classList.toggle('hidden', Boolean(activeBackend) || krmziBtn.getAttribute('aria-pressed') !== 'true');
    }
    new MutationObserver(updateNotice).observe(krmziBtn, { attributes: true, attributeFilter: ['aria-pressed'] });
    backendReady.then(updateNotice);
    connectBtn.addEventListener('click', () => {
      const address = isLoopback(savedBackend) ? savedBackend : localBackend;
      connect(address, connectBtn, message => { noticeStatus.textContent = message; }, true);
    });
    document.getElementById('openGatewaySettings').addEventListener('click', () => {
      document.getElementById('openSettingsBtn').click();
      serverUrlInput.focus();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWebGatewaySettings);
  } else {
    initWebGatewaySettings();
  }
})();
