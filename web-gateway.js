// ZOET Web API Interceptor, Gateway Router & Web Settings Controller
(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const qApi = urlParams.get('api');
  if (qApi) {
    localStorage.setItem('zoet_backend_url', qApi.replace(/\/+$/, ''));
  }

  // On static web hosting without a custom backend, default unset/'all' to cinemana for instant playback
  if (!localStorage.getItem('zoet_backend_url')) {
    const curSource = localStorage.getItem('zoet_source');
    if (!curSource || curSource === 'all') {
      localStorage.setItem('zoet_source', 'cinemana');
      localStorage.setItem('otium_source', 'cinemana');
    }
  }

  const originalFetch = window.fetch;
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
          console.error('[ZOET Cinemana Direct Fetch Error]:', targetUrl, err);
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
        showWebToast('يتطلب مصدر قرمزي ضبط خادم اتصال من تبويب «الإعدادات». سينمانا متاح مباشرة بدون خادم.');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWebGatewaySettings);
  } else {
    initWebGatewaySettings();
  }
})();
