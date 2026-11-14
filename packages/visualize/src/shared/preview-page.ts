export const visualizationPreviewPath = '/visualization-preview'

export const visualizationPreviewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts"

// 使用原始脚本文本，避免 tsx 命名 helper 或压缩器的闭包提升污染 iframe。
const visualizationPreviewScript = String.raw`
function initializeVisualizationPreview() {
    const token = location.hash.slice(1) || document.querySelector('meta[name="pi-visualization-token"]')?.content || window.name;
    const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
    if (!uuid.test(token) || parent === window)
        return;
    const root = document.getElementById('visualization-root');
    const encoder = new TextEncoder();
    const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
    const integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
    const bounded = (value, limit) => typeof value === 'string' && value.length <= limit && encoder.encode(value).length <= limit;
    const errorText = (cause) => String(cause instanceof Error ? cause.message : cause).slice(0, 2000);
    const readState = (value) => {
        if (!record(value))
            return;
        for (const [key, item] of Object.entries(value)) {
            if (!/^[a-z][\w-]{0,63}$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
                return;
            if (typeof item !== 'boolean' && typeof item !== 'string' && typeof item !== 'number')
                return;
            if (typeof item === 'number' && !Number.isFinite(item))
                return;
            if (typeof item === 'string' && item.length > 16384)
                return;
        }
        return bounded(JSON.stringify(value), 16384) ? value : undefined;
    };
    const readColors = (value) => {
        if (!record(value) || Object.keys(value).length > 96)
            return;
        const colors = {};
        for (const [key, color] of Object.entries(value)) {
            if (!/^--[a-z][\w-]{0,79}$/i.test(key) || !bounded(color, 256) || !CSS.supports('color', color))
                return;
            colors[key] = color;
        }
        return colors;
    };
    const readEnvironment = (value) => {
        if (!record(value))
            return;
        const colors = readColors(value.colors);
        if (!colors ||
            !['light', 'dark'].includes(String(value.appearance)) ||
            typeof value.reducedMotion !== 'boolean' ||
            typeof value.visible !== 'boolean' ||
            !bounded(value.fontFamily, 512) ||
            !value.fontFamily.trim() ||
            typeof value.fontSize !== 'number' ||
            !Number.isFinite(value.fontSize) ||
            value.fontSize < 8 ||
            value.fontSize > 48 ||
            typeof value.radius !== 'number' ||
            !Number.isFinite(value.radius) ||
            value.radius < 0 ||
            value.radius > 64)
            return;
        return {
            appearance: value.appearance,
            reducedMotion: value.reducedMotion,
            visible: value.visible,
            fontFamily: value.fontFamily,
            fontSize: value.fontSize,
            radius: value.radius,
            colors,
        };
    };
    let port;
    let state = {};
    let sequence = -1;
    let next = 0;
    let environment = {
        appearance: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        visible: true,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        radius: 10,
        colors: {},
    };
    const listeners = new Set();
    const environmentListeners = new Set();
    const pending = new Map();
    let queuedPatch;
    let patchFrame = 0;
    const snapshotEnvironment = () => ({ ...environment, colors: { ...environment.colors } });
    const post = (message) => port?.postMessage(message);
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !event.isTrusted)
            return;
        queueMicrotask(() => {
            if (!event.defaultPrevented)
                post({ type: 'escape' });
        });
    });
    const report = (cause) => post({ type: 'error', message: errorText(cause) });
    const notifyState = () => {
        for (const listener of listeners) {
            try {
                listener({ ...state });
            }
            catch (cause) {
                report(cause);
            }
        }
    };
    const acceptState = (value, incomingSequence) => {
        const incoming = readState(value);
        if (!incoming || !integer(incomingSequence))
            throw new Error('可视化状态消息无效');
        if (incomingSequence <= sequence)
            return;
        sequence = incomingSequence;
        state = incoming;
        notifyState();
    };
    window.piVisualize = {
        getState: () => ({ ...state }),
        subscribe: (listener) => {
            if (typeof listener !== 'function')
                throw new Error('状态订阅者必须是函数');
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getEnvironment: snapshotEnvironment,
        subscribeEnvironment: (listener) => {
            if (typeof listener !== 'function')
                throw new Error('环境订阅者必须是函数');
            environmentListeners.add(listener);
            return () => environmentListeners.delete(listener);
        },
        setState: (patch) => new Promise((resolve, reject) => {
            const safePatch = readState(patch);
            const merged = { ...queuedPatch?.patch, ...safePatch };
            if (!port || !safePatch || !readState({ ...state, ...merged })) {
                reject(new Error(port ? '状态变更无效或超过 16 KiB' : '可视化尚未连接'));
                return;
            }
            if (queuedPatch) {
                if (queuedPatch.requests.length >= 1024) {
                    reject(new Error('单帧状态变更过多'));
                    return;
                }
                queuedPatch.patch = merged;
                queuedPatch.requests.push({ resolve, reject });
                return;
            }
            if (pending.size >= 64 || next === Number.MAX_SAFE_INTEGER) {
                reject(new Error('待确认的状态变更过多'));
                return;
            }
            const requestId = ++next;
            const requests = [{ resolve, reject }];
            const timeout = window.setTimeout(() => {
                pending.delete(requestId);
                if (queuedPatch?.requestId === requestId) {
                    cancelAnimationFrame(patchFrame);
                    patchFrame = 0;
                    queuedPatch = undefined;
                }
                for (const request of requests)
                    request.reject(new Error('状态变更确认超时'));
            }, 15000);
            pending.set(requestId, {
                resolve: (value) => requests.forEach((request) => request.resolve(value)),
                reject: (cause) => requests.forEach((request) => request.reject(cause)),
                timeout,
            });
            queuedPatch = { requestId, patch: merged, requests };
            patchFrame = requestAnimationFrame(() => {
                patchFrame = 0;
                const queued = queuedPatch;
                queuedPatch = undefined;
                if (queued)
                    post({ type: 'patch', patch: queued.patch, requestId: queued.requestId });
            });
        }),
        createChart: () => {
            throw new Error('未加载 ECharts；请在可视化 libraries 中声明 echarts');
        },
    };
    const applyTheme = (colors) => {
        for (const [key, color] of Object.entries(colors))
            document.documentElement.style.setProperty(key, color);
    };
    let measureFrame = 0;
    let lastHeight = -1;
    let previousMeasurement;
    const measure = () => {
        measureFrame = 0;
        if (!environment.visible)
            return;
        const bounds = root.getBoundingClientRect();
        const scrollbar = Math.max(0, window.innerHeight - document.documentElement.clientHeight);
        const height = Math.max(1, Math.ceil(Math.max(bounds.height, root.scrollHeight) + scrollbar));
        const width = Math.round(bounds.width);
        const viewport = window.innerHeight;
        const previous = previousMeasurement;
        previousMeasurement = { height, width, viewport };
        if (previous && previous.height === height && previous.width === width)
            return;
        // 不将 100vh / 百分比内容随 iframe 高度产生的变化反馈给父端。
        if (previous &&
            previous.width === width &&
            viewport !== previous.viewport &&
            Math.abs(height - previous.height - (viewport - previous.viewport)) <= 1)
            return;
        if (height === lastHeight)
            return;
        lastHeight = height;
        post({ type: 'height', height });
    };
    const scheduleMeasure = () => {
        if (!measureFrame && environment.visible)
            measureFrame = requestAnimationFrame(measure);
    };
    const applyEnvironment = (incoming) => {
        for (const key of Object.keys(environment.colors)) {
            if (!Object.hasOwn(incoming.colors, key))
                document.documentElement.style.removeProperty(key);
        }
        environment = incoming;
        const html = document.documentElement;
        html.dataset.appearance = incoming.appearance;
        html.classList.toggle('dark', incoming.appearance === 'dark');
        html.dataset.reducedMotion = String(incoming.reducedMotion);
        html.dataset.visible = String(incoming.visible);
        html.style.colorScheme = incoming.appearance;
        html.style.fontFamily = incoming.fontFamily;
        html.style.fontSize = incoming.fontSize + 'px';
        html.style.setProperty('--font-family', incoming.fontFamily);
        html.style.setProperty('--font-size', incoming.fontSize + 'px');
        html.style.setProperty('--font-size-base', incoming.fontSize + 'px');
        html.style.setProperty('--radius', incoming.radius + 'px');
        applyTheme(incoming.colors);
        for (const listener of environmentListeners) {
            try {
                listener(snapshotEnvironment());
            }
            catch (cause) {
                report(cause);
            }
        }
        scheduleMeasure();
    };
    let executionError;
    let executing = false;
    window.addEventListener('error', (event) => {
        if (executing)
            executionError = event.message;
        report(event.message);
    });
    window.addEventListener('unhandledrejection', (event) => report(event.reason));
    const execute = (source) => {
        const script = document.createElement('script');
        script.textContent = source;
        executionError = undefined;
        executing = true;
        try {
            document.head.append(script);
        }
        finally {
            executing = false;
            script.remove();
        }
        if (executionError)
            throw new Error(executionError);
    };
    let capturing = false;
    const captures = new Set();
    const capture = async (data) => {
        if (typeof data.requestId !== 'string' || !uuid.test(data.requestId))
            return;
        const requestId = data.requestId;
        if (captures.has(requestId))
            return;
        captures.add(requestId);
        if (captures.size > 64)
            captures.delete(captures.values().next().value);
        let timeout;
        let ownsCapture = false;
        try {
            if (!bounded(data.captureRuntime, 2 * 1048576))
                throw new Error('捕获运行时无效或过大');
            if (capturing)
                throw new Error('可视化正在导出');
            capturing = true;
            ownsCapture = true;
            if (!window.__piVisualizeCapture)
                execute(data.captureRuntime);
            if (typeof window.__piVisualizeCapture !== 'function')
                throw new Error('捕获运行时未初始化');
            const result = await Promise.race([
                window.__piVisualizeCapture(),
                new Promise((_resolve, reject) => {
                    timeout = window.setTimeout(() => reject(new Error('可视化导出超时')), 10000);
                }),
            ]);
            if (!record(result) ||
                !bounded(result.svg, 16 * 1048576) ||
                !/^data:image\/svg\+xml[;,]/.test(result.svg) ||
                !Number.isFinite(result.width) ||
                !Number.isFinite(result.height) ||
                result.width <= 0 ||
                result.height <= 0)
                throw new Error('捕获结果无效或超过 16 MiB');
            post({ type: 'capture-result', requestId, svg: result.svg, width: result.width, height: result.height });
        }
        catch (cause) {
            post({ type: 'capture-result', requestId, error: errorText(cause) });
        }
        finally {
            if (timeout !== undefined)
                window.clearTimeout(timeout);
            if (ownsCapture)
                capturing = false;
        }
    };
    const receive = ({ data }) => {
        if (!record(data))
            return;
        try {
            if (data.type === 'state')
                acceptState(data.state, data.sequence);
            if (data.type === 'reply' && integer(data.requestId)) {
                const request = pending.get(data.requestId);
                if (!request)
                    return;
                pending.delete(data.requestId);
                window.clearTimeout(request.timeout);
                if (data.error !== undefined) {
                    request.reject(new Error(bounded(data.error, 2000) ? data.error : '状态变更失败'));
                    return;
                }
                try {
                    // 老父端已先发 state；无序号的迟到 reply 不得回滚状态。
                    if (data.sequence !== undefined)
                        acceptState(data.state, data.sequence);
                    request.resolve({ ...state });
                }
                catch (cause) {
                    request.reject(new Error(errorText(cause)));
                }
            }
            if (data.type === 'theme') {
                const colors = readColors(data.values ?? data.colors);
                if (!colors)
                    throw new Error('可视化主题无效');
                applyEnvironment({ ...environment, colors });
            }
            if (data.type === 'environment') {
                const incoming = readEnvironment(data.environment);
                if (!incoming)
                    throw new Error('可视化环境无效');
                applyEnvironment(incoming);
            }
            if (data.type === 'capture')
                void capture(data);
        }
        catch (cause) {
            report(cause);
        }
    };
    window.addEventListener('message', function initialize(event) {
        const data = event.data;
        if (event.source !== parent || !record(data) || data.token !== token || event.ports.length !== 1)
            return;
        const connection = event.ports[0];
        try {
            const initial = readState(data.state);
            const colors = readColors(data.theme ?? {});
            const incomingEnvironment = data.environment === undefined ? undefined : readEnvironment(data.environment);
            if (!initial ||
                !integer(data.sequence) ||
                !bounded(data.html, 1048576) ||
                !colors ||
                (data.environment !== undefined && !incomingEnvironment))
                throw new Error('可视化初始化消息无效或过大');
            const assets = data.assets;
            if (assets !== undefined &&
                (!record(assets) ||
                    !bounded(assets.core, 8 * 1048576) ||
                    (assets.echarts !== undefined && !bounded(assets.echarts, 8 * 1048576))))
                throw new Error('可视化资源无效或过大');
            window.removeEventListener('message', initialize);
            port = connection;
            port.onmessage = receive;
            port.start();
            state = initial;
            sequence = data.sequence;
            applyTheme(colors);
            applyEnvironment(incomingEnvironment ?? { ...environment, colors });
            if (record(assets)) {
                execute(assets.core);
                if (typeof assets.echarts === 'string')
                    execute(assets.echarts);
            }
            root.innerHTML = data.html;
            window.piVisualize.refresh?.();
            for (const old of Array.from(root.querySelectorAll('script'))) {
                // 外链脚本由 CSP 禁止；保留 JSON 数据脚本，只执行内联经典脚本。
                if (old.src || (old.type && !/^(?:text|application)\/(?:java|ecma)script$/i.test(old.type)))
                    continue;
                const script = document.createElement('script');
                for (const attribute of Array.from(old.attributes))
                    script.setAttribute(attribute.name, attribute.value);
                script.textContent = old.textContent;
                old.replaceWith(script);
            }
            window.piVisualize.refresh?.();
            const resize = new ResizeObserver(scheduleMeasure);
            resize.observe(root);
            const mutations = new MutationObserver(scheduleMeasure);
            mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
            window.addEventListener('resize', scheduleMeasure);
            root.addEventListener('load', scheduleMeasure, true);
            void document.fonts.ready.then(scheduleMeasure);
            window.addEventListener('pagehide', () => {
                resize.disconnect();
                mutations.disconnect();
                cancelAnimationFrame(measureFrame);
                cancelAnimationFrame(patchFrame);
                queuedPatch = undefined;
                for (const request of pending.values()) {
                    window.clearTimeout(request.timeout);
                    request.reject(new Error('可视化已断开'));
                }
                pending.clear();
                port?.close();
                port = undefined;
            }, { once: true });
            post({ type: 'ready', runtimeVersion: 2 });
            scheduleMeasure();
        }
        catch (cause) {
            connection.postMessage({ type: 'error', message: errorText(cause) });
            connection.close();
        }
    });
}
initializeVisualizationPreview()
`

export const visualizationPreviewPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{height:auto;min-height:0;font:14px system-ui;color-scheme:light dark}body{margin:0;height:auto;min-height:0;color:var(--foreground,CanvasText);background:transparent;font:inherit}*{box-sizing:border-box}button,input,select,textarea{font:inherit;max-width:100%}#visualization-root{display:flow-root;min-width:0;min-height:0}[hidden]{display:none!important}</style></head><body><div id="visualization-root"></div><script>${visualizationPreviewScript}</script></body></html>`

export function visualizationPreviewResponse() {
  return new Response(visualizationPreviewPage, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': visualizationPreviewCsp,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
