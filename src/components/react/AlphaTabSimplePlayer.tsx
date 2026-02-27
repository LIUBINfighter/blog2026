import React, { useEffect, useRef, useState } from "react";

/**
 * 极简 AlphaTab 播放器（示例）
 * 目标：对比现有复杂实现，展示官方推荐的 alphaTex 使用方式：\n
 * 1. 通过 <script> 动态加载 alphaTab 运行时
 * 2. 当 source 是 alphaTex 时：
 *    - 优先使用 api.loadAlphaTex (alphaTab >=1.4 暴露)
 *    - 若不存在 loadAlphaTex：重新设置容器 innerText + core.tex=true 重新实例化
 * 3. 其它类型 (url / File / ArrayBuffer) 直接 api.load
 *
 * 不做：主题同步 / 进度条 / 轨道选择 / 高级渲染优化 —— 全部留给高级版本组件。
 */

// （与现有 AlphaTabPlayer 兼容）
export type SimpleAlphaTabSource =
  | { type: "url"; value: string }
  | { type: "alphaTex"; value: string }
  | { type: "file"; value: File }
  | { type: "arrayBuffer"; value: ArrayBuffer };

// 极简 AlphaTab 运行时公开对象最小子集（避免直接使用 any）：
interface MinimalAlphaTabApi {
  load: (src: string | ArrayBuffer | Blob | File) => void;
  loadAlphaTex?: (tex: string) => void;
  render?: () => void;
  destroy?: () => void;
  playerReady?: {
    on: (fn: () => void) => void;
    off?: (fn: () => void) => void;
  };
  renderFinished?: {
    on: (fn: () => void) => void;
    off?: (fn: () => void) => void;
  };
  scoreLoaded?: {
    on: (fn: () => void) => void;
    off?: (fn: () => void) => void;
  };
}

interface AlphaTabSimplePlayerProps {
  source: SimpleAlphaTabSource | string; // 传 string 自动判别 url / alphaTex
  className?: string;
  /** 传入 false 可禁止自动拉取最新 CDN，改由外部预先注入 */
  autoLoadScript?: boolean;
  /** 自定义 soundfont url；为空则使用默认内置 */
  soundFontUrl?: string;
  /** 实例创建或重建后的回调 */
  onApi?: (api: MinimalAlphaTabApi | null) => void;
}

// 不重新声明 window.alphaTab（主播放器已声明全量 AlphaTabGlobals）；这里仅做运行时存在性判断。

const ALPHATAB_CDN =
  "https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/alphaTab.js";
const DEFAULT_SF2 =
  "https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/soundfont/sonivox.sf2";

let runtimePromise: Promise<void> | null = null;

function ensureRuntime(autoLoad: boolean): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("alphaTab 仅在浏览器环境可用"));
  }
  if (window.alphaTab) return Promise.resolve();
  if (!autoLoad) {
    return window.alphaTab
      ? Promise.resolve()
      : Promise.reject(
          new Error("alphaTab 运行时未注入且 autoLoadScript=false")
        );
  }
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src='${ALPHATAB_CDN}']`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("alphaTab 脚本加载失败")),
          { once: true }
        );
        return;
      }
      const s = document.createElement("script");
      s.src = ALPHATAB_CDN;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("alphaTab 脚本加载失败"));
      document.head.appendChild(s);
    });
  }
  return runtimePromise;
}

// 简单判定：包含典型 alphaTex 指令或多行 & 以反斜杠开头的元数据
function detectStringSource(raw: string): SimpleAlphaTabSource {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { type: "url", value: trimmed };
  }
  const directives =
    /(^|\n)\\(title|tempo|track|staff|instrument|ts|articulation|multiBarRest)\b/i;
  if (directives.test(trimmed) || /\n/.test(trimmed)) {
    return { type: "alphaTex", value: trimmed };
  }
  // 回退：按 url 尝试（也允许用户写相对路径）
  return { type: "url", value: trimmed };
}

const AlphaTabSimplePlayer: React.FC<AlphaTabSimplePlayerProps> = ({
  source,
  className,
  autoLoadScript = true,
  soundFontUrl,
  onApi,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<MinimalAlphaTabApi | null>(null);
  const [status, setStatus] = useState<
    "init" | "loading-runtime" | "ready" | "loading-score" | "error"
  >("init");
  const [error, setError] = useState<string | null>(null);

  // 将任意 props.source 归一化
  const normalized: SimpleAlphaTabSource =
    typeof source === "string" ? detectStringSource(source) : source;

  // 创建 / 重建 API （当 alphaTex fallback 需要重建时会调用）
  const createApi = (texMode: boolean) => {
    if (!hostRef.current || !window.alphaTab) return null;
    // 清理旧实例
    if (apiRef.current) {
      try {
        apiRef.current.destroy?.();
      } catch {
        /* noop */
      }
      apiRef.current = null;
    }
    const opts: Record<string, unknown> = {
      player: {
        enablePlayer: true,
        soundFont: soundFontUrl || DEFAULT_SF2,
      },
    };
    if (texMode) {
      opts.core = { tex: true };
    }
    const api = new window.alphaTab.AlphaTabApi(hostRef.current, opts);
    apiRef.current = api;
    onApi?.(api);
    return api;
  };

  // 初次加载 runtime
  useEffect(() => {
    let cancelled = false;
    setStatus("loading-runtime");
    ensureRuntime(autoLoadScript)
      .then(() => {
        if (cancelled) return;
        setStatus("ready");
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.message || String(e));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [autoLoadScript]);

  // 加载乐谱
  useEffect(() => {
    if (status !== "ready") return; // 需要 runtime 就绪
    if (!window.alphaTab) return;
    const texMode = normalized.type === "alphaTex";
    // 如果是 alphaTex 且我们准备走 core.tex=true 方式，需要把文本塞进容器（官方示例）
    if (texMode) {
      if (hostRef.current) hostRef.current.textContent = normalized.value;
    } else if (hostRef.current) {
      hostRef.current.textContent = ""; // 非 tex 渲染时保持空
    }
    const api = createApi(texMode);
    if (!api) return;

    setStatus("loading-score");
    setError(null);
    try {
      if (texMode) {
        // 优先使用 loadAlphaTex（如果存在，避免重新实例化）
        if (typeof api.loadAlphaTex === "function") {
          api.loadAlphaTex(normalized.value);
        } else {
          // 已经 core.tex=true 且 host 内含文本，会被自动解析；此处可选调用 render()
          api.render?.();
        }
      } else {
        switch (normalized.type) {
          case "url":
            api.load(normalized.value);
            break;
          case "file":
            api.load(normalized.value);
            break;
          case "arrayBuffer":
            api.load(normalized.value);
            break;
          default:
            break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
      return;
    }

    // 监听几个简单事件更新状态
    const offRenderFinished = () => {
      setStatus(prev => (prev === "loading-score" ? "ready" : prev));
    };
    api.renderFinished?.on(offRenderFinished);
    api.scoreLoaded?.on(() => {
      setStatus("ready");
    });
    api.playerReady?.on(() => {
      // 保证 ready
      setStatus("ready");
    });
    return () => {
      try {
        api.renderFinished?.off?.(offRenderFinished);
      } catch {
        /* noop */
      }
    };
  }, [status, normalized.type, normalized.value]);

  // 卸载清理
  useEffect(() => {
    return () => {
      try {
        apiRef.current?.destroy?.();
      } catch {
        /* noop */
      }
      onApi?.(null);
    };
  }, [onApi]);

  return (
    <div className={className}>
      <div
        ref={hostRef}
        data-simple-alphatab
        className="relative min-h-24 w-full overflow-auto rounded-xl border border-[color:var(--at-border-color,_#ccc)] bg-[color:var(--at-panel-bg,_#fff)] p-4 font-mono text-sm"
      />
      {status === "loading-runtime" && (
        <p className="mt-2 text-xs text-[color:var(--at-text-tertiary,_#666)]">
          正在加载 alphaTab 运行时…
        </p>
      )}
      {status === "loading-score" && (
        <p className="mt-2 text-xs text-[color:var(--at-text-tertiary,_#666)]">
          正在解析乐谱…
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs break-all text-red-500">加载失败：{error}</p>
      )}
    </div>
  );
};

export default AlphaTabSimplePlayer;
