(function () {
  function installLayaProfiler() {
    var profilerVersion = "0.1.1";
    if (window.__LayaProfiler && window.__LayaProfiler.version === profilerVersion) {
      return { ok: true, reused: true };
    }

    var state = {
      version: profilerVersion,
      logs: [],
      frameSamples: [],
      frameId: 0,
      lastFrameTime: performance.now(),
      fpsWindow: [],
      drawCallTracker: null,
      consoleHooked: false,
      statVisible: false
    };

    function findLaya() {
      if (window.Laya) return window.Laya;
      if (window.laya && window.laya.Laya) return window.laya.Laya;
      return null;
    }

    function typeName(value) {
      if (!value) return "Unknown";
      if (value.__className) return value.__className;
      if (value.constructor && value.constructor.name) return value.constructor.name;
      return Object.prototype.toString.call(value).slice(8, -1);
    }

    function safeNumber(value, fallback) {
      var next = Number(value);
      return Number.isFinite(next) ? next : fallback;
    }

    function round(value, digits) {
      var factor = Math.pow(10, digits || 0);
      return Math.round(safeNumber(value, 0) * factor) / factor;
    }

    function compact(value, depth, seen) {
      if (value == null) return value;
      var valueType = typeof value;
      if (valueType === "number" || valueType === "boolean" || valueType === "string") {
        return value;
      }
      if (valueType === "function") {
        return "[Function " + (value.name || "anonymous") + "]";
      }
      if (!seen) seen = new WeakSet();
      if (seen.has(value)) return "[Circular]";
      if (depth <= 0) return "[" + typeName(value) + "]";

      seen.add(value);
      if (Array.isArray(value)) {
        return value.slice(0, 40).map(function (item) {
          return compact(item, depth - 1, seen);
        });
      }

      var output = {};
      Object.keys(value).slice(0, 80).forEach(function (key) {
        if (key.charAt(0) === "_" && depth < 2) return;
        try {
          output[key] = compact(value[key], depth - 1, seen);
        } catch (error) {
          output[key] = "[Unreadable]";
        }
      });
      return output;
    }

    function hookConsole() {
      if (state.consoleHooked) return;
      state.consoleHooked = true;
      ["log", "info", "warn", "error", "debug"].forEach(function (level) {
        var original = console[level];
        if (typeof original !== "function") return;
        console[level] = function () {
          var args = Array.prototype.slice.call(arguments);
          state.logs.push({
            time: Date.now(),
            level: level,
            message: args.map(function (item) {
              if (typeof item === "string") return item;
              try {
                return JSON.stringify(compact(item, 2));
              } catch (error) {
                return String(item);
              }
            }).join(" ")
          });
          if (state.logs.length > 300) state.logs.shift();
          return original.apply(console, arguments);
        };
      });
    }

    function sampleFrame(now) {
      var delta = now - state.lastFrameTime;
      state.lastFrameTime = now;
      state.frameId += 1;
      state.fpsWindow.push(now);
      while (state.fpsWindow.length && now - state.fpsWindow[0] > 1000) {
        state.fpsWindow.shift();
      }
      state.frameSamples.push({
        time: Date.now(),
        frame: state.frameId,
        frameTime: round(delta, 2),
        fps: state.fpsWindow.length
      });
      if (state.frameSamples.length > 180) state.frameSamples.shift();
      requestAnimationFrame(sampleFrame);
    }

    function getChildren(node) {
      if (!node) return [];
      if (Array.isArray(node._children)) return node._children;
      if (Array.isArray(node.children)) return node.children;
      var children = [];
      var count = safeNumber(node.numChildren, 0);
      if (count && typeof node.getChildAt === "function") {
        for (var index = 0; index < count; index += 1) {
          try {
            children.push(node.getChildAt(index));
          } catch (error) {}
        }
      }
      return children;
    }

    function walkNode(node, depth, path, seen, counters) {
      if (!node || seen.has(node) || depth > 32) return null;
      seen.add(node);
      counters.count += 1;
      var children = getChildren(node);
      var item = {
        id: node.$_GID || node._id || node.id || path,
        path: path,
        name: node.name || typeName(node),
        type: typeName(node),
        visible: node.visible !== false,
        active: node.active !== false && node.destroyed !== true,
        x: round(node.x, 2),
        y: round(node.y, 2),
        width: round(node.width, 2),
        height: round(node.height, 2),
        scaleX: round(node.scaleX == null ? 1 : node.scaleX, 3),
        scaleY: round(node.scaleY == null ? 1 : node.scaleY, 3),
        alpha: round(node.alpha == null ? 1 : node.alpha, 3),
        childCount: children.length,
        children: []
      };

      item.children = children.map(function (child, index) {
        return walkNode(child, depth + 1, path + "." + index, seen, counters);
      }).filter(Boolean);
      return item;
    }

    function valuesFromCollection(collection) {
      if (!collection) return [];
      if (collection instanceof Map) {
        return Array.from(collection.entries()).map(function (entry) {
          return { key: entry[0], value: entry[1] };
        });
      }
      if (Array.isArray(collection)) {
        return collection.map(function (value, index) {
          return { key: index, value: value };
        });
      }
      if (typeof collection === "object") {
        return Object.keys(collection).map(function (key) {
          return { key: key, value: collection[key] };
        });
      }
      return [];
    }

    function resourceCandidates(resource) {
      var queue = [resource];
      var seen = new WeakSet();
      var output = [];
      var fields = [
        "content",
        "data",
        "resource",
        "texture",
        "_texture",
        "bitmap",
        "_bitmap",
        "source",
        "_source",
        "image",
        "_image",
        "nativeObj",
        "_nativeObj",
        "_nativeTexture",
        "_glTexture",
        "_texture2D"
      ];

      for (var index = 0; index < queue.length && output.length < 80; index += 1) {
        var item = queue[index];
        if (!item || typeof item !== "object" || seen.has(item)) continue;
        seen.add(item);
        if (Array.isArray(item)) {
          item.forEach(function (child) {
            if (child && typeof child === "object") queue.push(child);
          });
          continue;
        }
        if (item instanceof Map) {
          item.forEach(function (child) {
            if (child && typeof child === "object") queue.push(child);
          });
          continue;
        }
        output.push(item);
        fields.forEach(function (field) {
          try {
            var value = item[field];
            if (value && typeof value === "object") queue.push(value);
          } catch (error) {}
        });
      }
      return output;
    }

    function readPositiveNumber(object, fields) {
      if (!object || typeof object !== "object") return 0;
      for (var index = 0; index < fields.length; index += 1) {
        try {
          var value = Number(object[fields[index]]);
          if (Number.isFinite(value) && value > 0) return value;
        } catch (error) {}
      }
      return 0;
    }

    function gpuMemoryBytes(resource) {
      var explicitFields = [
        "gpuMemory",
        "_gpuMemory",
        "gpuMemorySize",
        "_gpuMemorySize",
        "gpuMemoryUsage",
        "_gpuMemoryUsage",
        "videoMemory",
        "_videoMemory",
        "_glTextureMemory"
      ];
      var candidates = resourceCandidates(resource);
      for (var index = 0; index < candidates.length; index += 1) {
        var explicit = readPositiveNumber(candidates[index], explicitFields);
        if (explicit) return round(explicit, 0);
      }

      var dimensions = resourceDimensions(resource);
      if (!dimensions.width || !dimensions.height) return 0;
      return round(dimensions.width * dimensions.height * bytesPerPixel(resource), 0);
    }

    function bytesPerPixel(resource) {
      var candidates = resourceCandidates(resource);
      var format = "";
      for (var index = 0; index < candidates.length; index += 1) {
        var item = candidates[index];
        try {
          format = String(item.format || item._format || item.textureFormat || item._textureFormat || item.colorFormat || "");
        } catch (error) {
          format = "";
        }
        if (format) break;
      }

      var normalized = format.toLowerCase();
      if (/alpha8|r8|a8/.test(normalized)) return 1;
      if (/rgb565|rgba4444|rgba5551/.test(normalized)) return 2;
      if (/rgb\b|rgb8|6407/.test(normalized)) return 3;
      return 4;
    }

    function resourceDimensions(resource) {
      var pairs = [
        ["width", "height"],
        ["_width", "_height"],
        ["sourceWidth", "sourceHeight"],
        ["_sourceWidth", "_sourceHeight"],
        ["_w", "_h"],
        ["naturalWidth", "naturalHeight"],
        ["videoWidth", "videoHeight"]
      ];
      var candidates = resourceCandidates(resource);
      var best = { width: 0, height: 0, area: 0 };
      for (var objectIndex = 0; objectIndex < candidates.length; objectIndex += 1) {
        var object = candidates[objectIndex];
        for (var pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
          var pair = pairs[pairIndex];
          var width = 0;
          var height = 0;
          try {
            width = safeNumber(object[pair[0]], 0);
            height = safeNumber(object[pair[1]], 0);
          } catch (error) {}
          if (width > 0 && height > 0) {
            var area = width * height;
            if (area > best.area) {
              best = { width: round(width, 0), height: round(height, 0), area: area };
            }
          }
        }
      }
      return { width: best.width, height: best.height };
    }

    function resourceSize(resource) {
      var dimensions = resourceDimensions(resource);
      return dimensions.width && dimensions.height ? dimensions.width + "x" + dimensions.height : "-";
    }

    function resourceTypeName(resource, url) {
      var priority = [
        "Texture2DArray",
        "RenderTexture",
        "TextureCube",
        "Texture3D",
        "Texture2D",
        "BaseTexture",
        "Texture",
        "Mesh",
        "Material",
        "Shader3D",
        "Sprite3D",
        "Prefab",
        "Atlas",
        "Json",
        "Sound",
        "Font",
        "HTMLImageElement",
        "HTMLCanvasElement"
      ];
      var names = [];
      resourceCandidates(resource).forEach(function (candidate) {
        [
          candidate.resourceType,
          candidate._resourceType,
          candidate.typeName,
          candidate._typeName,
          candidate.__className,
          candidate.type,
          candidate._type,
          typeName(candidate)
        ].forEach(function (name) {
          if (typeof name === "string" && name) names.push(name);
        });
      });

      var joined = names.join(" ");
      var resourceUrl = url || sourceUrl(resource);
      if (/\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(resourceUrl)) {
        if (!joined || joined.indexOf("Texture") !== -1 || joined.indexOf("HTMLImageElement") !== -1) return "Texture2D";
      }
      for (var index = 0; index < priority.length; index += 1) {
        if (joined.indexOf(priority[index]) !== -1) return priority[index];
      }
      if (/\.(lh|ls|scene|prefab)(\?|#|$)/i.test(resourceUrl)) return "Prefab";
      if (/\.(json|atlas)(\?|#|$)/i.test(resourceUrl)) return "Json";
      if (/\.(mp3|wav|ogg|m4a)(\?|#|$)/i.test(resourceUrl)) return "Sound";
      if (/\.(fnt|ttf|woff2?)(\?|#|$)/i.test(resourceUrl)) return "Font";
      return names[0] || typeName(resource);
    }

    function referenceCount(resource) {
      var fields = [
        "referenceCount",
        "_referenceCount",
        "refCount",
        "_refCount",
        "ref",
        "_ref",
        "useCount",
        "_useCount",
        "retainCount",
        "_retainCount"
      ];
      var candidates = resourceCandidates(resource);
      for (var objectIndex = 0; objectIndex < candidates.length; objectIndex += 1) {
        var object = candidates[objectIndex];
        for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
          try {
            var raw = object[fields[fieldIndex]];
            if (raw == null || raw === "") continue;
            var value = Number(raw);
            if (Number.isFinite(value) && value >= 0) return round(value, 0);
          } catch (error) {}
        }
      }
      return null;
    }

    function absoluteUrl(url) {
      if (!url || typeof url !== "string") return "";
      if (/^(data:|blob:|https?:|file:|chrome-extension:)/i.test(url)) return url;
      try {
        return new URL(url, location.href).href;
      } catch (error) {
        return url;
      }
    }

    function sourceUrl(source) {
      if (!source) return "";
      if (typeof source === "string") return source;
      return source.currentSrc || source.src || source.url || source._url || source.path || source._path || "";
    }

    function bitmapPreview(source) {
      if (!source || typeof source !== "object") return "";
      var isCanvas = source instanceof HTMLCanvasElement ||
        (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas);
      var isImage = source instanceof HTMLImageElement && source.complete && source.naturalWidth && source.naturalHeight;
      if (!isCanvas && !isImage) return "";
      try {
        var maxSize = 192;
        var sourceWidth = isImage ? source.naturalWidth : source.width;
        var sourceHeight = isImage ? source.naturalHeight : source.height;
        var scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
        var width = Math.max(1, Math.round(sourceWidth * scale));
        var height = Math.max(1, Math.round(sourceHeight * scale));
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(source, 0, 0, width, height);
        return canvas.toDataURL("image/png");
      } catch (error) {
        return "";
      }
    }

    function previewCandidates(resource, url) {
      var queue = [
        resource,
        resource && resource.content,
        resource && resource.data,
        resource && resource.resource,
        resource && resource.texture,
        resource && resource._texture,
        resource && resource.bitmap,
        resource && resource._bitmap,
        resource && resource.source,
        resource && resource._source,
        resource && resource.image,
        resource && resource._image,
        resource && resource.nativeObj,
        resource && resource._nativeObj
      ];
      var candidates = [url];
      var seen = new WeakSet();
      var fields = [
        "url",
        "_url",
        "src",
        "_src",
        "currentSrc",
        "path",
        "_path",
        "source",
        "_source",
        "bitmap",
        "_bitmap",
        "image",
        "_image",
        "texture",
        "_texture",
        "content",
        "data",
        "nativeObj",
        "_nativeObj"
      ];

      for (var index = 0; index < queue.length; index += 1) {
        var item = queue[index];
        if (!item) continue;
        if (typeof item === "string") {
          candidates.push(item);
          continue;
        }
        if (typeof item !== "object" || seen.has(item)) continue;
        seen.add(item);
        if (Array.isArray(item)) {
          item.forEach(function (child) {
            if (typeof child === "string") candidates.push(child);
            else if (child && typeof child === "object" && queue.length < 60) queue.push(child);
          });
          continue;
        }
        if (item instanceof Map) {
          item.forEach(function (child) {
            if (typeof child === "string") candidates.push(child);
            else if (child && typeof child === "object" && queue.length < 60) queue.push(child);
          });
          continue;
        }
        candidates.push(bitmapPreview(item));
        candidates.push(sourceUrl(item));
        fields.forEach(function (field) {
          try {
            var value = item[field];
            if (!value) return;
            if (typeof value === "string") candidates.push(value);
            else if (queue.length < 60) queue.push(value);
          } catch (error) {}
        });
      }

      return candidates;
    }

    function resourcePreviewUrl(resource, url) {
      var candidates = previewCandidates(resource, url);
      var imageExt = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i;
      for (var index = 0; index < candidates.length; index += 1) {
        var next = absoluteUrl(candidates[index]);
        if (!next) continue;
        if (/^(data:image\/|blob:)/i.test(next) || imageExt.test(next)) return next;
      }
      return "";
    }

    function collectResources(Laya) {
      var seen = new WeakSet();
      var resources = [];
      var sources = [
        { name: "Laya.Loader.loadedMap", value: Laya && Laya.Loader && Laya.Loader.loadedMap },
        { name: "Laya.Loader._resMap", value: Laya && Laya.Loader && Laya.Loader._resMap },
        { name: "Laya.loader._resMap", value: Laya && Laya.loader && Laya.loader._resMap },
        { name: "Laya.loader._cache", value: Laya && Laya.loader && Laya.loader._cache },
        { name: "Laya.Resource._idResources", value: Laya && Laya.Resource && Laya.Resource._idResources },
        { name: "Laya.Resource._urlResources", value: Laya && Laya.Resource && Laya.Resource._urlResources }
      ];

      function add(key, value, source) {
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        var bytes = gpuMemoryBytes(value);
        var url = value.url || value._url || value.src || value._src || sourceUrl(value) || String(key || "");
        var previewUrl = resourcePreviewUrl(value, url);
        var refs = referenceCount(value);
        resources.push({
          id: value.$_GID || value.id || value._id || resources.length + 1,
          name: value.name || url || typeName(value),
          url: url,
          previewUrl: previewUrl,
          source: source,
          type: resourceTypeName(value, url),
          bytes: bytes,
          size: resourceSize(value),
          refCount: refs,
          refText: refs === 0 ? "空闲" : refs == null ? "-" : String(refs),
          destroyed: value.destroyed === true,
          detail: compact(value, 1)
        });
      }

      function betterType(current, next) {
        if (!current || current === "Array" || current === "Object" || current === "Unknown") return next;
        if (current === "Texture" && next === "Texture2D") return next;
        return current;
      }

      function mergeResources(items) {
        var byKey = {};
        items.forEach(function (item) {
          var key = absoluteUrl(item.url) || item.name || String(item.id);
          var existing = byKey[key];
          if (!existing) {
            byKey[key] = item;
            return;
          }
          existing.previewUrl = existing.previewUrl || item.previewUrl;
          existing.bytes = Math.max(existing.bytes || 0, item.bytes || 0);
          if (!existing.size || existing.size === "-") existing.size = item.size;
          existing.type = betterType(existing.type, item.type);
          if (existing.refCount == null && item.refCount != null) {
            existing.refCount = item.refCount;
            existing.refText = item.refText;
          }
          if (existing.source.indexOf(item.source) === -1) {
            existing.source += ", " + item.source;
          }
          existing.destroyed = existing.destroyed || item.destroyed;
        });
        return Object.keys(byKey).map(function (key) {
          return byKey[key];
        });
      }

      sources.forEach(function (source) {
        valuesFromCollection(source.value).forEach(function (entry) {
          add(entry.key, entry.value, source.name);
        });
      });

      return mergeResources(resources).sort(function (a, b) {
        return b.bytes - a.bytes;
      }).slice(0, 1000);
    }

    function firstNumber(values) {
      for (var index = 0; index < values.length; index += 1) {
        var value = Number(values[index]);
        if (Number.isFinite(value)) return value;
      }
      return 0;
    }

    function drawCallValue(Laya, stat) {
      var render = Laya && Laya.Render;
      var renderInfo = Laya && Laya.RenderInfo;
      var immediate = firstNumber([
        stat.drawCallNum,
        stat.drawCalls,
        stat.drawCallCount,
        stat.renderBatch,
        stat.renderBatchNum,
        renderInfo && renderInfo.drawCall,
        renderInfo && renderInfo.drawCallNum,
        render && render.drawCall,
        render && render.drawCallNum
      ]);
      if (immediate > 0) return round(immediate, 0);

      var raw = firstNumber([
        stat.drawCall,
        stat._drawCall
      ]);
      if (!raw) return 0;

      var tracker = state.drawCallTracker;
      var currentFrame = state.frameId;
      state.drawCallTracker = { value: raw, frame: currentFrame };
      if (!tracker || raw < tracker.value || currentFrame <= tracker.frame) {
        return round(raw, 0);
      }

      var delta = raw - tracker.value;
      var frameDelta = currentFrame - tracker.frame;
      if (delta > 0 && frameDelta > 0) {
        return round(delta / frameDelta, 0);
      }
      return round(raw, 0);
    }

    function collectStats(Laya, nodeCount, resources) {
      var stat = Laya && Laya.Stat ? Laya.Stat : {};
      var latest = state.frameSamples[state.frameSamples.length - 1] || {};
      var heap = performance.memory && performance.memory.usedJSHeapSize ? performance.memory.usedJSHeapSize : 0;
      var gpuMemory = resources.reduce(function (sum, item) {
        return sum + safeNumber(item.bytes, 0);
      }, 0);
      return {
        fps: safeNumber(stat.FPS || stat.fps, latest.fps || 0),
        frameTime: safeNumber(stat.renderTime || stat.frameTime, latest.frameTime || 0),
        heapUsed: heap,
        gpuMemory: gpuMemory,
        drawCall: drawCallValue(Laya, stat),
        node: nodeCount,
        sprite: safeNumber(stat.spriteCount || stat.spriteNum, 0),
        triangle: safeNumber(stat.triangles || stat.triangleFaces, 0),
        shaderCall: safeNumber(stat.shaderCall || stat.shaderCallNum, 0),
        renderTime: safeNumber(stat.renderTime, 0),
        updateTime: safeNumber(stat.updateTime, 0)
      };
    }

    function collectConfig(Laya) {
      var stage = Laya && Laya.stage;
      return {
        "Laya 版本": Laya && (Laya.version || Laya.VERSION) || "未检测到",
        "渲染模式": Laya && Laya.Render ? typeName(Laya.Render) : "Unknown",
        "Stage 尺寸": stage ? stage.width + " x " + stage.height : "-",
        "Stage 缩放": stage ? stage.scaleMode || "-" : "-",
        "屏幕方向": stage ? stage.screenMode || "-" : "-",
        "背景颜色": stage ? stage.bgColor || "-" : "-",
        "帧率模式": stage ? stage.frameRate || "-" : "-",
        "Canvas 数量": document.querySelectorAll("canvas").length,
        "设备像素比": window.devicePixelRatio || 1,
        "页面地址": location.href,
        "Config": compact(Laya && Laya.Config ? Laya.Config : {}, 2)
      };
    }

    function collectRuntimeState(Laya) {
      var stateCandidates = {};
      [
        "__LayaProfilerState",
        "__APP_STATE__",
        "__INITIAL_STATE__",
        "gameState",
        "GameState",
        "store",
        "game",
        "Game"
      ].forEach(function (key) {
        try {
          var value = window[key];
          if (!value) return;
          if (key === "store" && typeof value.getState === "function") {
            stateCandidates[key] = compact(value.getState(), 3);
          } else {
            stateCandidates[key] = compact(value, 2);
          }
        } catch (error) {
          stateCandidates[key] = "[Unreadable]";
        }
      });

      if (Laya && Laya.stage) {
        stateCandidates.Stage = compact({
          mouseX: Laya.stage.mouseX,
          mouseY: Laya.stage.mouseY,
          focused: Laya.stage.focus && (Laya.stage.focus.name || typeName(Laya.stage.focus)),
          timerScale: Laya.timer && Laya.timer.scale
        }, 2);
      }
      return stateCandidates;
    }

    function gpuSummary(resources) {
      var buckets = {};
      var total = 0;
      resources.forEach(function (resource) {
        var bytes = safeNumber(resource.bytes, 0);
        total += bytes;
        var bucket = resource.type || "Unknown";
        buckets[bucket] = (buckets[bucket] || 0) + bytes;
      });
      return {
        total: total,
        known: total,
        unknown: 0,
        count: resources.length,
        buckets: Object.keys(buckets).sort().map(function (name) {
          return { name: name, bytes: buckets[name] };
        })
      };
    }

    function collect() {
      var Laya = findLaya();
      var counters = { count: 0 };
      var tree = Laya && Laya.stage ? walkNode(Laya.stage, 0, "0", new WeakSet(), counters) : null;
      var resources = collectResources(Laya);
      var stats = collectStats(Laya, counters.count, resources);
      return {
        ok: true,
        time: Date.now(),
        detected: !!Laya,
        runtimeLabel: Laya ? "LayaAir " + (Laya.version || Laya.VERSION || "") : "未检测到 Laya",
        nodes: tree,
        config: collectConfig(Laya),
        resources: resources,
        gpu: gpuSummary(resources),
        state: collectRuntimeState(Laya),
        frame: {
          samples: state.frameSamples.slice(-120),
          stats: {
            frameId: state.frameId,
            fps: stats.fps,
            frameTime: stats.frameTime,
            renderTime: stats.renderTime,
            updateTime: stats.updateTime,
            drawCall: stats.drawCall,
            triangle: stats.triangle,
            shaderCall: stats.shaderCall
          }
        },
        console: state.logs.slice(-200),
        monitor: stats
      };
    }

    function command(name) {
      var Laya = findLaya();
      if (!Laya) return { ok: false, message: "未检测到 Laya 运行时" };
      try {
        if (name === "toggleStat") {
          state.statVisible = !state.statVisible;
          if (state.statVisible && Laya.Stat && typeof Laya.Stat.show === "function") {
            Laya.Stat.show(0, 0);
          } else if (!state.statVisible && Laya.Stat && typeof Laya.Stat.hide === "function") {
            Laya.Stat.hide();
          }
          return { ok: true, message: state.statVisible ? "Stat 面板已显示" : "Stat 面板已隐藏" };
        }
        if (name === "gc") {
          if (Laya.Resource && typeof Laya.Resource.destroyUnusedResources === "function") {
            Laya.Resource.destroyUnusedResources();
          }
          if (window.gc) window.gc();
          return { ok: true, message: "已请求资源回收" };
        }
        if (name === "pauseGame") {
          if (Laya.timer) Laya.timer.scale = 0;
          return { ok: true, message: "Laya.timer.scale = 0" };
        }
        if (name === "resumeGame") {
          if (Laya.timer) Laya.timer.scale = 1;
          return { ok: true, message: "Laya.timer.scale = 1" };
        }
        return { ok: false, message: "未知命令: " + name };
      } catch (error) {
        return { ok: false, message: error.message || String(error) };
      }
    }

    hookConsole();
    requestAnimationFrame(sampleFrame);

    window.__LayaProfiler = {
      version: state.version,
      collect: collect,
      command: command
    };

    return { ok: true, reused: false };
  }

  window.installLayaProfiler = installLayaProfiler;
})();
