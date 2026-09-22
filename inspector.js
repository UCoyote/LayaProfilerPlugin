(function () {
  function installLayaProfiler() {
    var profilerVersion = "0.2.0";
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
      lastWebGLDrawTotal: 0,
      lastWebGLDrawCalls: 0,
      consoleHooked: false,
      webglHooked: false,
      highlightLooping: false,
      statVisible: false
    };

    function findLaya() {
      if (window.Laya) return window.Laya;
      if (window.laya && window.laya.Laya) return window.laya.Laya;
      return null;
    }

    function findCocos() {
      var cc = window.cc || null;
      if (cc && (cc.director || cc.game || cc.assetManager || cc.ENGINE_VERSION)) return cc;
      return null;
    }

    function layaRuntimeVersion(Laya) {
      try {
        if (window.Laya && window.Laya.LayaEnv && window.Laya.LayaEnv.version) return window.Laya.LayaEnv.version;
      } catch (error) {}
      try {
        if (Laya && Laya.LayaEnv && Laya.LayaEnv.version) return Laya.LayaEnv.version;
      } catch (error) {}
      try {
        if (window.LayaEnv && window.LayaEnv.version) return window.LayaEnv.version;
      } catch (error) {}
      return Laya && (Laya.version || Laya.VERSION) || "";
    }

    function cocosRuntimeVersion(cc) {
      try {
        if (cc && cc.ENGINE_VERSION) return String(cc.ENGINE_VERSION);
      } catch (error) {}
      try {
        if (window.CocosEngine) return String(window.CocosEngine);
      } catch (error) {}
      return "";
    }

    function isLayaReady(Laya) {
      return !!(Laya && Laya.stage);
    }

    function isCocosReady(cc) {
      try {
        return !!(cc && cc.director && typeof cc.director.getScene === "function" && cc.director.getScene());
      } catch (error) {
        return false;
      }
    }

    function detectEngine() {
      var Laya = findLaya();
      var cc = findCocos();
      var layaReady = isLayaReady(Laya);
      var cocosReady = isCocosReady(cc);
      if (layaReady && !cocosReady) return { type: "laya", Laya: Laya, cc: null };
      if (cocosReady && !layaReady) return { type: "cocos", Laya: null, cc: cc };
      if (layaReady && cocosReady) return { type: "laya", Laya: Laya, cc: cc };
      if (Laya) return { type: "laya", Laya: Laya, cc: null };
      if (cc) return { type: "cocos", Laya: null, cc: cc };
      return { type: "none", Laya: null, cc: null };
    }

    function getEngineRoot(engine) {
      engine = engine || detectEngine();
      if (engine.type === "cocos" && engine.cc && engine.cc.director && typeof engine.cc.director.getScene === "function") {
        try {
          return engine.cc.director.getScene();
        } catch (error) {
          return null;
        }
      }
      if (engine.Laya) return engine.Laya.stage || null;
      return null;
    }

    function engineClassName(value, engine) {
      try {
        if (engine && engine.type === "cocos" && engine.cc && engine.cc.js && typeof engine.cc.js.getClassName === "function") {
          var name = engine.cc.js.getClassName(value);
          if (name) return name;
        }
      } catch (error) {}
      return typeName(value);
    }

    function typeName(value) {
      if (!value) return "Unknown";
      if (value.__className) return value.__className;
      if (value.__classname__) return value.__classname__;
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
      function parseStackLine(line) {
        var text = String(line || "").trim();
        var match = text.match(/^at\s+(.*?)\s+\((.+):(\d+):(\d+)\)$/) ||
          text.match(/^at\s+(.+):(\d+):(\d+)$/);
        if (match && match.length === 5) {
          return {
            fn: match[1] || "(anonymous)",
            url: match[2],
            line: safeNumber(match[3], 0),
            column: safeNumber(match[4], 0)
          };
        }
        if (match && match.length === 4) {
          return {
            fn: "(anonymous)",
            url: match[1],
            line: safeNumber(match[2], 0),
            column: safeNumber(match[3], 0)
          };
        }
        match = text.match(/^(.*?)@(.+):(\d+):(\d+)$/);
        if (match) {
          return {
            fn: match[1] || "(anonymous)",
            url: match[2],
            line: safeNumber(match[3], 0),
            column: safeNumber(match[4], 0)
          };
        }
        return null;
      }

      function captureConsoleStack() {
        var stack = "";
        try {
          stack = new Error().stack || "";
        } catch (error) {
          stack = "";
        }
        if (!stack) return [];
        return stack.split("\n").map(parseStackLine).filter(function (frame) {
          if (!frame || !frame.url || !frame.line) return false;
          return String(frame.url).indexOf("inspector.js") === -1;
        }).slice(0, 80);
      }

      ["log", "info", "warn", "error", "debug"].forEach(function (level) {
        var original = console[level];
        if (typeof original !== "function") return;
        console[level] = function () {
          var args = Array.prototype.slice.call(arguments);
          var entry = {
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
          };
          if (level === "warn" || level === "error") {
            entry.stack = captureConsoleStack();
          }
          state.logs.push(entry);
          if (state.logs.length > 300) state.logs.shift();
          return original.apply(console, arguments);
        };
      });
    }

    function hookWebGLDrawCalls() {
      if (state.webglHooked) return;
      state.webglHooked = true;
      var drawState = window.__LayaProfilerDrawState || { calls: 0 };
      window.__LayaProfilerDrawState = drawState;

      function wrapMethod(target, name) {
        if (!target || typeof target[name] !== "function" || target[name].__layaProfilerWrapped) return;
        var original = target[name];
        var wrapped = function () {
          var current = window.__LayaProfilerDrawState;
          if (current) current.calls += 1;
          return original.apply(this, arguments);
        };
        wrapped.__layaProfilerWrapped = true;
        wrapped.__layaProfilerOriginal = original;
        try {
          target[name] = wrapped;
        } catch (error) {}
      }

      function wrapContextPrototype(Context) {
        if (!Context || !Context.prototype) return;
        [
          "drawArrays",
          "drawElements",
          "drawArraysInstanced",
          "drawElementsInstanced",
          "drawRangeElements",
          "multiDrawArraysWEBGL",
          "multiDrawElementsWEBGL"
        ].forEach(function (name) {
          wrapMethod(Context.prototype, name);
        });

        if (typeof Context.prototype.getExtension === "function" && !Context.prototype.getExtension.__layaProfilerWrapped) {
          var originalGetExtension = Context.prototype.getExtension;
          var wrappedGetExtension = function () {
            var extension = originalGetExtension.apply(this, arguments);
            if (extension) {
              wrapMethod(extension, "drawArraysInstancedANGLE");
              wrapMethod(extension, "drawElementsInstancedANGLE");
              wrapMethod(extension, "multiDrawArraysWEBGL");
              wrapMethod(extension, "multiDrawElementsWEBGL");
            }
            return extension;
          };
          wrappedGetExtension.__layaProfilerWrapped = true;
          wrappedGetExtension.__layaProfilerOriginal = originalGetExtension;
          try {
            Context.prototype.getExtension = wrappedGetExtension;
          } catch (error) {}
        }
      }

      wrapContextPrototype(window.WebGLRenderingContext);
      wrapContextPrototype(window.WebGL2RenderingContext);
    }

    function sampleFrame(now) {
      var delta = now - state.lastFrameTime;
      state.lastFrameTime = now;
      state.frameId += 1;
      var drawState = window.__LayaProfilerDrawState;
      var drawTotal = drawState ? safeNumber(drawState.calls, 0) : 0;
      state.lastWebGLDrawCalls = Math.max(0, drawTotal - state.lastWebGLDrawTotal);
      state.lastWebGLDrawTotal = drawTotal;
      state.fpsWindow.push(now);
      while (state.fpsWindow.length && now - state.fpsWindow[0] > 1000) {
        state.fpsWindow.shift();
      }
      state.frameSamples.push({
        time: Date.now(),
        frame: state.frameId,
        frameTime: round(delta, 2),
        fps: state.fpsWindow.length,
        drawCall: state.lastWebGLDrawCalls
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

    function getCocosClass(cc, names) {
      if (!cc) return null;
      for (var index = 0; index < names.length; index += 1) {
        var name = names[index];
        try {
          if (cc[name]) return cc[name];
          if (cc.js && typeof cc.js.getClassByName === "function") {
            var found = cc.js.getClassByName(name) || cc.js.getClassByName("cc." + name);
            if (found) return found;
          }
        } catch (error) {}
      }
      return null;
    }

    function getCocosComponent(node, cc, names) {
      if (!node || typeof node.getComponent !== "function") return null;
      var cls = getCocosClass(cc, names);
      try {
        if (cls) {
          var byClass = node.getComponent(cls);
          if (byClass) return byClass;
        }
      } catch (error) {}
      for (var index = 0; index < names.length; index += 1) {
        try {
          var byName = node.getComponent(names[index]) || node.getComponent("cc." + names[index]);
          if (byName) return byName;
        } catch (error) {}
      }
      var raw = node._components || node.components || [];
      for (var compIndex = 0; compIndex < raw.length; compIndex += 1) {
        var type = typeName(raw[compIndex]);
        for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
          if (type.indexOf(names[nameIndex].replace(/^cc\./, "")) !== -1) return raw[compIndex];
        }
      }
      return null;
    }

    function getCocosComponents(node, cc) {
      var list = [];
      try {
        if (typeof node.getComponents === "function") {
          var cls = getCocosClass(cc, ["Component"]);
          var comps = cls ? node.getComponents(cls) : node.getComponents("cc.Component");
          if (comps && comps.length) {
            return comps.map(function (comp) {
              return engineClassName(comp, { type: "cocos", cc: cc });
            }).filter(Boolean);
          }
        }
      } catch (error) {}
      var raw = node._components || node.components || [];
      for (var index = 0; index < raw.length; index += 1) {
        list.push(engineClassName(raw[index], { type: "cocos", cc: cc }));
      }
      return list;
    }

    function readVecAxis(value, axis, fallback) {
      if (value == null) return fallback;
      try {
        var next = Number(value[axis]);
        if (Number.isFinite(next)) return next;
      } catch (error) {}
      return fallback;
    }

    function readLayaNode(node) {
      var alpha = round(node.alpha == null ? 1 : node.alpha, 3);
      return {
        name: node.$owner && node.$owner.name ? node.$owner.name : node.name || typeName(node),
        nodeName: node.name || "",
        ownerName: node.$owner && node.$owner.name ? node.$owner.name : "",
        type: typeName(node),
        visible: node.visible !== false,
        active: node.active !== false && node.destroyed !== true,
        mouseEnabled: node.mouseEnabled !== false,
        mouseThrough: node.mouseThrough === true,
        x: round(node.x, 2),
        y: round(node.y, 2),
        z: 0,
        width: round(node.width, 2),
        height: round(node.height, 2),
        pivotX: round(node.pivotX || 0, 2),
        pivotY: round(node.pivotY || 0, 2),
        skewX: round(node.skewX || 0, 2),
        skewY: round(node.skewY || 0, 2),
        rotation: round(node.rotation || 0, 2),
        eulerX: 0,
        eulerY: 0,
        eulerZ: round(node.rotation || 0, 2),
        scaleX: round(node.scaleX == null ? 1 : node.scaleX, 3),
        scaleY: round(node.scaleY == null ? 1 : node.scaleY, 3),
        scaleZ: 1,
        alpha: alpha,
        opacity: round(alpha * 255, 0),
        zOrder: round(node.zOrder || 0, 0),
        layer: 0,
        uuid: String(node.$_GID || node._id || node.id || ""),
        components: [],
        destroyed: node.destroyed === true
      };
    }

    function readCocosNode(node, cc, counters) {
      var pos = node.position || {};
      var scale = node.scale || {};
      var euler = node.eulerAngles || {};
      var ui = getCocosComponent(node, cc, ["UITransform"]);
      var opacityComp = getCocosComponent(node, cc, ["UIOpacity"]);
      var opacity = 255;
      if (opacityComp && opacityComp.opacity != null) opacity = safeNumber(opacityComp.opacity, 255);
      var components = getCocosComponents(node, cc);
      if (counters && components.some(function (name) {
        return /Sprite|MeshRenderer|SkinnedMeshRenderer|UIRenderer|Particle|Label|SpriteRenderer/.test(String(name));
      })) {
        counters.sprite += 1;
      }
      return {
        name: node.name || engineClassName(node, { type: "cocos", cc: cc }),
        nodeName: node.name || "",
        ownerName: "",
        type: engineClassName(node, { type: "cocos", cc: cc }),
        visible: node.activeInHierarchy !== false,
        active: node.active !== false,
        mouseEnabled: true,
        mouseThrough: false,
        x: round(readVecAxis(pos, "x", 0), 2),
        y: round(readVecAxis(pos, "y", 0), 2),
        z: round(readVecAxis(pos, "z", 0), 2),
        width: ui ? round(ui.width, 2) : 0,
        height: ui ? round(ui.height, 2) : 0,
        pivotX: ui ? round(ui.anchorX, 3) : 0.5,
        pivotY: ui ? round(ui.anchorY, 3) : 0.5,
        skewX: 0,
        skewY: 0,
        rotation: round(node.angle != null ? node.angle : readVecAxis(euler, "z", 0), 2),
        eulerX: round(readVecAxis(euler, "x", 0), 2),
        eulerY: round(readVecAxis(euler, "y", 0), 2),
        eulerZ: round(readVecAxis(euler, "z", 0), 2),
        scaleX: round(readVecAxis(scale, "x", 1), 3),
        scaleY: round(readVecAxis(scale, "y", 1), 3),
        scaleZ: round(readVecAxis(scale, "z", 1), 3),
        alpha: round(opacity / 255, 3),
        opacity: round(opacity, 0),
        zOrder: round(typeof node.getSiblingIndex === "function" ? node.getSiblingIndex() : node.siblingIndex || 0, 0),
        layer: node.layer != null ? node.layer : 0,
        uuid: node.uuid || "",
        components: components,
        destroyed: node.isValid === false
      };
    }

    function walkNode(node, depth, path, seen, counters, engine) {
      if (!node || seen.has(node) || depth > 32) return null;
      if (node.__layaProfilerOverlay) return null;
      seen.add(node);
      counters.count += 1;
      var children = getChildren(node);
      var props = engine && engine.type === "cocos" ? readCocosNode(node, engine.cc, counters) : readLayaNode(node);
      var item = {
        id: node.uuid || node.$_GID || node._id || node.id || path,
        path: path,
        childCount: children.length,
        children: []
      };
      Object.keys(props).forEach(function (key) {
        item[key] = props[key];
      });

      item.children = children.map(function (child, index) {
        return walkNode(child, depth + 1, path + "." + index, seen, counters, engine);
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
        "_texture2D",
        "_gfxTexture",
        "gfxTexture",
        "nativeAsset",
        "_nativeAsset"
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
        "SpriteFrame",
        "ImageAsset",
        "EffectAsset",
        "AnimationClip",
        "AudioClip",
        "BufferAsset",
        "JsonAsset",
        "TextAsset",
        "BitmapFont",
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
      return source.currentSrc || source.src || source.url || source._url || source.nativeUrl || source._nativeUrl || source.path || source._path || "";
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
        resource && resource._nativeObj,
        resource && resource.nativeAsset,
        resource && resource._nativeAsset
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

    function eachCache(cache, callback) {
      if (!cache) return;
      if (typeof cache.forEach === "function") {
        try {
          cache.forEach(function (value, key) {
            callback(key, value);
          });
          return;
        } catch (error) {}
      }
      var map = cache._map || cache.map || cache._data;
      if (!map) return;
      if (map instanceof Map) {
        map.forEach(function (value, key) {
          callback(key, value);
        });
        return;
      }
      Object.keys(map).forEach(function (key) {
        callback(key, map[key]);
      });
    }

    function collectLayaResources(Laya) {
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

    function collectCocosResources(cc) {
      var seen = new WeakSet();
      var resources = [];

      function add(key, value, source) {
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        var bytes = gpuMemoryBytes(value);
        var url = value.nativeUrl || value._nativeUrl || value.url || value._url || sourceUrl(value) || value.uuid || value._uuid || String(key || "");
        var previewUrl = resourcePreviewUrl(value, url);
        var refs = referenceCount(value);
        if (refs == null && value.refCount != null) refs = round(safeNumber(value.refCount, 0), 0);
        resources.push({
          id: value.uuid || value._uuid || value.$_GID || value.id || resources.length + 1,
          name: value.name || url || engineClassName(value, { type: "cocos", cc: cc }),
          url: url,
          previewUrl: previewUrl,
          source: source,
          type: resourceTypeName(value, url),
          bytes: bytes,
          size: resourceSize(value),
          refCount: refs,
          refText: refs === 0 ? "空闲" : refs == null ? "-" : String(refs),
          destroyed: value.destroyed === true || value.isValid === false,
          detail: compact(value, 1)
        });
      }

      if (cc && cc.assetManager) {
        eachCache(cc.assetManager.assets, function (key, value) {
          add(key, value, "cc.assetManager.assets");
        });
      }

      return resources.sort(function (a, b) {
        return b.bytes - a.bytes;
      }).slice(0, 1000);
    }

    function collectResources(engine) {
      if (engine && engine.type === "cocos") return collectCocosResources(engine.cc);
      return collectLayaResources(engine && engine.Laya);
    }

    function firstNumber(values) {
      for (var index = 0; index < values.length; index += 1) {
        var value = Number(values[index]);
        if (Number.isFinite(value)) return value;
      }
      return 0;
    }

    function firstPositiveNumber(values) {
      for (var index = 0; index < values.length; index += 1) {
        var value = Number(values[index]);
        if (Number.isFinite(value) && value > 0) return value;
      }
      return 0;
    }

    function drawCallValue(Laya, stat) {
      var render = Laya && Laya.Render;
      var renderInfo = Laya && Laya.RenderInfo;
      var webglDrawCalls = safeNumber(state.lastWebGLDrawCalls, 0);
      if (webglDrawCalls > 0) return round(webglDrawCalls, 0);
      var immediate = firstPositiveNumber([
        stat.drawCallNum,
        stat.drawCalls,
        stat.drawCallCount,
        stat.drawCallCountNum,
        stat.renderBatch,
        stat.renderBatchNum,
        stat.renderBatches,
        stat.batch,
        stat.batchCount,
        stat._drawCallNum,
        stat._renderBatch,
        stat._renderBatchNum,
        renderInfo && renderInfo.drawCall,
        renderInfo && renderInfo.drawCallNum,
        renderInfo && renderInfo.drawCalls,
        renderInfo && renderInfo.renderBatch,
        renderInfo && renderInfo.renderBatchNum,
        render && render.drawCall,
        render && render.drawCallNum,
        render && render.drawCalls,
        render && render.renderBatch,
        render && render.renderBatchNum
      ]);
      if (immediate > 0) return round(immediate, 0);

      var raw = firstPositiveNumber([
        stat.drawCall,
        stat.drawCallTotal,
        stat.totalDrawCall,
        stat._drawCallTotal,
        renderInfo && renderInfo.drawCallTotal,
        renderInfo && renderInfo.totalDrawCall,
        render && render.drawCallTotal,
        render && render.totalDrawCall
      ]);
      if (!raw) return round(webglDrawCalls, 0);

      var tracker = state.drawCallTracker;
      var currentFrame = state.frameId;
      state.drawCallTracker = { value: raw, frame: currentFrame };
      if (!tracker || raw < tracker.value || currentFrame <= tracker.frame) {
        return round(webglDrawCalls || raw, 0);
      }

      var delta = raw - tracker.value;
      var frameDelta = currentFrame - tracker.frame;
      if (delta > 0 && frameDelta > 0) {
        return round(delta / frameDelta, 0);
      }
      return round(webglDrawCalls, 0);
    }

    function profilerCounterValue(item) {
      if (item == null) return 0;
      if (typeof item === "number") return safeNumber(item, 0);
      try {
        if (item.counter && item.counter.value != null) return safeNumber(item.counter.value, 0);
        if (item.value != null) return safeNumber(item.value, 0);
      } catch (error) {}
      return 0;
    }

    function getCocosDevice(cc) {
      try {
        return cc && cc.director && cc.director.root && cc.director.root.device || null;
      } catch (error) {
        return null;
      }
    }

    function getCocosDeviceGpuBytes(cc) {
      var device = getCocosDevice(cc);
      var memory = device && device.memoryStatus;
      if (!memory) return 0;
      return round(safeNumber(memory.textureSize, 0) + safeNumber(memory.bufferSize, 0), 0);
    }

    function collectLayaStats(Laya, nodeCount, resources) {
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

    function collectCocosStats(cc, nodeCount, spriteCount, resources) {
      var latest = state.frameSamples[state.frameSamples.length - 1] || {};
      var heap = performance.memory && performance.memory.usedJSHeapSize ? performance.memory.usedJSHeapSize : 0;
      var profiler = cc && cc.profiler;
      var stats = profiler && profiler.stats ? profiler.stats : {};
      var device = getCocosDevice(cc);
      var attributed = resources.reduce(function (sum, item) {
        return sum + safeNumber(item.bytes, 0);
      }, 0);
      var deviceGpu = getCocosDeviceGpuBytes(cc);
      var webglDrawCalls = safeNumber(state.lastWebGLDrawCalls, 0);
      var deltaTime = 0;
      try {
        if (cc.director && typeof cc.director.getDeltaTime === "function") deltaTime = cc.director.getDeltaTime() * 1000;
      } catch (error) {}
      return {
        fps: firstPositiveNumber([profilerCounterValue(stats.fps), latest.fps]) || safeNumber(latest.fps, 0),
        frameTime: firstPositiveNumber([profilerCounterValue(stats.frame), deltaTime, latest.frameTime]) || safeNumber(latest.frameTime, 0),
        heapUsed: heap,
        gpuMemory: deviceGpu > 0 ? deviceGpu : attributed,
        gpuKnown: attributed,
        gpuDevice: deviceGpu,
        drawCall: firstPositiveNumber([
          device && device.numDrawCalls,
          profilerCounterValue(stats.draws),
          webglDrawCalls
        ]) || round(webglDrawCalls, 0),
        node: nodeCount,
        sprite: spriteCount || 0,
        triangle: firstPositiveNumber([device && device.numTris, profilerCounterValue(stats.tricount)]),
        shaderCall: 0,
        renderTime: profilerCounterValue(stats.render),
        updateTime: profilerCounterValue(stats.logic)
      };
    }

    function collectStats(engine, nodeCount, spriteCount, resources) {
      if (engine && engine.type === "cocos") return collectCocosStats(engine.cc, nodeCount, spriteCount, resources);
      return collectLayaStats(engine && engine.Laya, nodeCount, resources);
    }

    function gameConfigRoot() {
      try {
        return window.config && typeof window.config === "object" ? window.config : null;
      } catch (error) {
        return null;
      }
    }

    function configDataCount(data) {
      if (!data || typeof data !== "object") return 0;
      try {
        if (Array.isArray(data)) return data.length;
        return Object.keys(data).length;
      } catch (error) {
        return 0;
      }
    }

    function cloneGameConfigData(value, depth, seen) {
      if (value == null) return value;
      var valueType = typeof value;
      if (valueType === "number" || valueType === "boolean" || valueType === "string") return value;
      if (valueType === "undefined") return "[Undefined]";
      if (valueType === "function") return "[Function " + (value.name || "anonymous") + "]";
      if (!seen) seen = new WeakSet();
      if (seen.has(value)) return "[Circular]";
      if (depth <= 0) return "[" + typeName(value) + "]";
      seen.add(value);
      if (Array.isArray(value)) {
        return value.map(function (item) {
          return cloneGameConfigData(item, depth - 1, seen);
        });
      }
      var output = {};
      Object.keys(value).forEach(function (key) {
        try {
          output[key] = cloneGameConfigData(value[key], depth - 1, seen);
        } catch (error) {
          output[key] = "[Unreadable]";
        }
      });
      return output;
    }

    function collectConfig() {
      var root = gameConfigRoot();
      if (!root) {
        return {
          detected: false,
          rootName: "config",
          tables: []
        };
      }
      var tables = [];
      Object.keys(root).forEach(function (key) {
        if (!/Tbs$/i.test(key)) return;
        var table = null;
        var data = null;
        try {
          table = root[key];
          data = table && table.data;
        } catch (error) {}
        tables.push({
          name: key,
          type: typeName(table),
          hasData: !!data && typeof data === "object",
          count: configDataCount(data)
        });
      });
      return {
        detected: true,
        rootName: "config",
        tables: tables
      };
    }

    function getGameConfigTable(name) {
      var root = gameConfigRoot();
      if (!root || !name || !/Tbs$/i.test(String(name))) return null;
      try {
        return root[name] || null;
      } catch (error) {
        return null;
      }
    }

    function gameConfigValueAtPath(data, path, createMissing) {
      var current = data;
      for (var index = 0; index < path.length; index += 1) {
        if (!current || typeof current !== "object") return null;
        var key = path[index];
        if (index === path.length - 1) return { target: current, key: key, value: current[key] };
        if (current[key] == null && createMissing) current[key] = {};
        current = current[key];
      }
      return { target: null, key: null, value: current };
    }

    function getLocalValueAtPath(data, path) {
      var current = data;
      for (var index = 0; index < path.length; index += 1) {
        if (!current || typeof current !== "object") return undefined;
        current = current[path[index]];
      }
      return current;
    }

    function collectRuntimeState(engine) {
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

      var Laya = engine && engine.Laya;
      if (Laya && Laya.stage) {
        stateCandidates.Stage = compact({
          mouseX: Laya.stage.mouseX,
          mouseY: Laya.stage.mouseY,
          focused: Laya.stage.focus && (Laya.stage.focus.name || typeName(Laya.stage.focus)),
          timerScale: Laya.timer && Laya.timer.scale
        }, 2);
      }

      var cc = engine && engine.cc;
      if (engine && engine.type === "cocos" && cc && cc.director) {
        var scene = null;
        var scheduler = null;
        try {
          scene = cc.director.getScene();
        } catch (error) {}
        try {
          scheduler = typeof cc.director.getScheduler === "function" ? cc.director.getScheduler() : null;
        } catch (error) {}
        stateCandidates.Scene = compact({
          name: scene && scene.name,
          paused: typeof cc.director.isPaused === "function" ? cc.director.isPaused() : false,
          timerScale: scheduler && typeof scheduler.getTimeScale === "function" ? scheduler.getTimeScale() : 1
        }, 2);
      }
      return stateCandidates;
    }

    function readTimerScale(engine) {
      try {
        if (engine && engine.type === "cocos" && engine.cc && engine.cc.director && typeof engine.cc.director.getScheduler === "function") {
          var scheduler = engine.cc.director.getScheduler();
          if (scheduler && typeof scheduler.getTimeScale === "function") return safeNumber(scheduler.getTimeScale(), 1);
        }
      } catch (error) {}
      try {
        if (engine && engine.Laya && engine.Laya.timer) return safeNumber(engine.Laya.timer.scale, 1);
      } catch (error) {}
      return 1;
    }

    function ensureHighlightOverlay() {
      var overlay = document.getElementById("__layaProfilerNodeHighlight");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "__layaProfilerNodeHighlight";
        overlay.style.cssText = "position:fixed;display:none;pointer-events:none;z-index:2147483647;border:2px solid #ff2f3f;box-shadow:0 0 0 1px rgba(255,47,63,.25),0 0 10px rgba(255,47,63,.35);box-sizing:border-box;";
        document.documentElement.appendChild(overlay);
      }
      return overlay;
    }

    function ensureStageHighlightOverlay(Laya) {
      if (!Laya || !Laya.stage || typeof Laya.Sprite !== "function") return null;
      var overlay = window.__LayaProfilerStageHighlight;
      if (!overlay || overlay.destroyed) {
        overlay = new Laya.Sprite();
        overlay.name = "__LayaProfilerNodeHighlight";
        overlay.__layaProfilerOverlay = true;
        overlay.mouseEnabled = false;
        overlay.mouseThrough = true;
        overlay.zOrder = 2147483647;
        window.__LayaProfilerStageHighlight = overlay;
      }
      if (overlay.parent !== Laya.stage && typeof Laya.stage.addChild === "function") {
        Laya.stage.addChild(overlay);
      }
      try {
        if (typeof Laya.stage.setChildIndex === "function") {
          Laya.stage.setChildIndex(overlay, Math.max(0, Laya.stage.numChildren - 1));
        }
      } catch (error) {}
      return overlay;
    }

    function hideStageHighlightOverlay() {
      var overlay = window.__LayaProfilerStageHighlight;
      if (!overlay) return;
      overlay.visible = false;
      try {
        if (overlay.graphics && typeof overlay.graphics.clear === "function") overlay.graphics.clear();
      } catch (error) {}
    }

    function isCanvasElement(value) {
      return value && value.nodeType === 1 && String(value.tagName).toLowerCase() === "canvas";
    }

    function unwrapCanvas(value) {
      if (isCanvasElement(value)) return value;
      if (!value || typeof value !== "object") return null;
      return isCanvasElement(value.source) ? value.source :
        isCanvasElement(value.canvas) ? value.canvas :
        isCanvasElement(value._source) ? value._source :
        isCanvasElement(value._canvas) ? value._canvas : null;
    }

    function findLayaCanvas(Laya) {
      var candidates = [];
      function add(value) {
        var canvas = unwrapCanvas(value);
        if (canvas && candidates.indexOf(canvas) === -1) candidates.push(canvas);
      }

      if (Laya) {
        add(Laya.Render && Laya.Render.canvas);
        add(Laya.Render && Laya.Render._mainCanvas);
        add(Laya.Render && Laya.Render._context && Laya.Render._context.canvas);
        add(Laya.Browser && Laya.Browser.canvas);
        add(Laya.stage && Laya.stage.canvas);
      }

      Array.prototype.forEach.call(document.querySelectorAll("canvas"), add);
      for (var index = 0; index < candidates.length; index += 1) {
        if (candidates[index].isConnected !== false) return candidates[index];
      }
      return candidates[0] || null;
    }

    function findCocosCanvas(cc) {
      var candidates = [];
      function add(value) {
        var canvas = unwrapCanvas(value);
        if (canvas && candidates.indexOf(canvas) === -1) candidates.push(canvas);
      }
      if (cc && cc.game) {
        add(cc.game.canvas);
        add(cc.game.container && cc.game.container.querySelector && cc.game.container.querySelector("canvas"));
      }
      Array.prototype.forEach.call(document.querySelectorAll("canvas"), add);
      for (var index = 0; index < candidates.length; index += 1) {
        if (candidates[index].isConnected !== false) return candidates[index];
      }
      return candidates[0] || null;
    }

    function findCocosCamera(cc, node) {
      var cameras = [];
      try {
        var root = cc && cc.director && cc.director.root;
        if (root && Array.isArray(root.cameraList)) {
          root.cameraList.forEach(function (camera) {
            if (camera && cameras.indexOf(camera) === -1) cameras.push(camera);
          });
        }
      } catch (error) {}
      try {
        var scene = cc && cc.director && cc.director.getScene();
        var cameraClass = getCocosClass(cc, ["Camera"]);
        if (scene && typeof scene.getComponentsInChildren === "function" && cameraClass) {
          var found = scene.getComponentsInChildren(cameraClass) || [];
          found.forEach(function (camera) {
            if (camera && cameras.indexOf(camera) === -1) cameras.push(camera);
          });
        }
      } catch (error) {}
      var layer = node && node.layer;
      for (var index = 0; index < cameras.length; index += 1) {
        var camera = cameras[index];
        var visibility = camera.visibility != null ? camera.visibility : camera._visibility;
        var cameraNode = camera.node;
        var active = !cameraNode || cameraNode.activeInHierarchy !== false;
        if (!active) continue;
        if (layer == null || visibility == null || (visibility & layer)) return camera;
      }
      return cameras[0] || null;
    }

    function cocosWorldToClient(worldX, worldY, worldZ, cc, camera, canvas, rect) {
      var screenX = worldX;
      var screenY = worldY;
      try {
        if (camera && typeof camera.worldToScreen === "function") {
          var vec = cc && cc.Vec3 ? new cc.Vec3(worldX, worldY, worldZ || 0) : { x: worldX, y: worldY, z: worldZ || 0 };
          var out = camera.worldToScreen(vec);
          if (out) {
            screenX = safeNumber(out.x, worldX);
            screenY = safeNumber(out.y, worldY);
          }
        }
      } catch (error) {}
      var dpr = window.devicePixelRatio || 1;
      try {
        if (cc && cc.view && typeof cc.view.getDevicePixelRatio === "function") {
          dpr = cc.view.getDevicePixelRatio() || dpr;
        }
      } catch (error) {}
      var canvasWidth = canvas && canvas.width ? canvas.width : rect.width;
      var canvasHeight = canvas && canvas.height ? canvas.height : rect.height;
      var cssWidth = canvasWidth / Math.max(dpr, 0.01);
      var cssHeight = canvasHeight / Math.max(dpr, 0.01);
      return {
        x: rect.left + (screenX / Math.max(dpr, 0.01)) * (rect.width / Math.max(cssWidth, 1)),
        y: rect.top + ((canvasHeight - screenY) / Math.max(dpr, 0.01)) * (rect.height / Math.max(cssHeight, 1))
      };
    }

    function nodeCocosGlobalBounds(node, cc) {
      if (!node || !cc) return null;
      var canvas = findCocosCanvas(cc);
      var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      var camera = findCocosCamera(cc, node);
      var corners = [];
      var ui = getCocosComponent(node, cc, ["UITransform"]);
      try {
        if (ui && typeof ui.getBoundingBoxToWorld === "function") {
          var box = ui.getBoundingBoxToWorld();
          var x = safeNumber(box.x, 0);
          var y = safeNumber(box.y, 0);
          var width = safeNumber(box.width, 0);
          var height = safeNumber(box.height, 0);
          if (width && height) {
            corners = [
              [x, y, 0],
              [x + width, y, 0],
              [x + width, y + height, 0],
              [x, y + height, 0]
            ];
          }
        }
      } catch (error) {}
      if (!corners.length) {
        var pos = node.worldPosition;
        try {
          if (!pos && typeof node.getWorldPosition === "function") pos = node.getWorldPosition();
        } catch (error) {}
        if (!pos) pos = node.position || { x: 0, y: 0, z: 0 };
        var px = safeNumber(pos.x, 0);
        var py = safeNumber(pos.y, 0);
        var pz = safeNumber(pos.z, 0);
        corners = [
          [px - 20, py - 20, pz],
          [px + 20, py - 20, pz],
          [px + 20, py + 20, pz],
          [px - 20, py + 20, pz]
        ];
      }
      var points = corners.map(function (corner) {
        return cocosWorldToClient(corner[0], corner[1], corner[2], cc, camera, canvas, rect);
      });
      var left = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      var right = Math.max(points[0].x, points[1].x, points[2].x, points[3].x);
      var top = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      var bottom = Math.max(points[0].y, points[1].y, points[2].y, points[3].y);
      return {
        left: left,
        top: top,
        width: right - left,
        height: bottom - top
      };
    }

    function readMatrix(value) {
      if (!value || typeof value !== "object") return null;
      var a = safeNumber(value.a, NaN);
      var b = safeNumber(value.b, 0);
      var c = safeNumber(value.c, 0);
      var d = safeNumber(value.d, NaN);
      if (!Number.isFinite(a) || !Number.isFinite(d) || (!a && !d)) return null;
      return {
        a: a,
        b: b,
        c: c,
        d: d,
        tx: safeNumber(value.tx, 0),
        ty: safeNumber(value.ty, 0)
      };
    }

    function readCssMatrix(element) {
      if (!element || !window.getComputedStyle) return null;
      var transform = "";
      try {
        transform = window.getComputedStyle(element).transform || "";
      } catch (error) {
        transform = "";
      }
      if (!transform || transform === "none") return null;
      var match = transform.match(/^matrix\(([^)]+)\)$/);
      if (!match) return null;
      var parts = match[1].split(",").map(function (part) {
        return Number(part.trim());
      });
      if (parts.length !== 6 || parts.some(function (part) { return !Number.isFinite(part); })) return null;
      return { a: parts[0], b: parts[1], c: parts[2], d: parts[3], tx: parts[4], ty: parts[5] };
    }

    function closeEnough(first, second) {
      return Math.abs(first - second) < 0.75;
    }

    function stagePointToClient(point, map) {
      return {
        x: map.left + point.x * map.a + point.y * map.c,
        y: map.top + point.x * map.b + point.y * map.d
      };
    }

    function stageClientMap(stage, canvas, rect) {
      var stageWidth = stage && stage.width ? stage.width : rect.width;
      var stageHeight = stage && stage.height ? stage.height : rect.height;
      var matrix = readMatrix(stage && (stage._canvasTransform || stage.canvasTransform));
      if (matrix) {
        var cssMatrix = readCssMatrix(canvas);
        var cssHasStageOffsetX = cssMatrix && closeEnough(cssMatrix.tx, matrix.tx);
        var cssHasStageOffsetY = cssMatrix && closeEnough(cssMatrix.ty, matrix.ty);
        var rectHasStageOffsetX = closeEnough(rect.left, matrix.tx);
        var rectHasStageOffsetY = closeEnough(rect.top, matrix.ty);
        return {
          left: rect.left + (cssHasStageOffsetX || rectHasStageOffsetX ? 0 : matrix.tx),
          top: rect.top + (cssHasStageOffsetY || rectHasStageOffsetY ? 0 : matrix.ty),
          a: matrix.a,
          b: matrix.b,
          c: matrix.c,
          d: matrix.d
        };
      }
      return {
        left: rect.left,
        top: rect.top,
        a: rect.width / Math.max(stageWidth, 1),
        b: 0,
        c: 0,
        d: rect.height / Math.max(stageHeight, 1)
      };
    }

    function nodeParent(node) {
      if (!node || typeof node !== "object") return null;
      return node.parent || node._parent || node.displayParent || node._displayParent || null;
    }

    function nodeMatrix(node) {
      if (!node) return null;
      return readMatrix(node.transform || node._transform || node._tf);
    }

    function nodeOwnNumber(node, fields, fallback) {
      for (var index = 0; index < fields.length; index += 1) {
        try {
          var value = Number(node[fields[index]]);
          if (Number.isFinite(value)) return value;
        } catch (error) {}
      }
      return fallback;
    }

    function transformPointByNode(node, point) {
      var x = point.x;
      var y = point.y;
      var matrix = nodeMatrix(node);
      var nodeX = nodeOwnNumber(node, ["x", "_x"], 0);
      var nodeY = nodeOwnNumber(node, ["y", "_y"], 0);
      if (matrix) {
        return {
          x: nodeX + x * matrix.a + y * matrix.c + matrix.tx,
          y: nodeY + x * matrix.b + y * matrix.d + matrix.ty
        };
      }

      var pivotX = nodeOwnNumber(node, ["pivotX", "_pivotX"], 0);
      var pivotY = nodeOwnNumber(node, ["pivotY", "_pivotY"], 0);
      var scaleX = nodeOwnNumber(node, ["scaleX", "_scaleX"], 1);
      var scaleY = nodeOwnNumber(node, ["scaleY", "_scaleY"], 1);
      var rotation = nodeOwnNumber(node, ["rotation", "_rotation"], 0) * Math.PI / 180;
      var skewX = nodeOwnNumber(node, ["skewX", "_skewX"], 0) * Math.PI / 180;
      var skewY = nodeOwnNumber(node, ["skewY", "_skewY"], 0) * Math.PI / 180;
      var localX = x - pivotX;
      var localY = y - pivotY;
      var a = scaleX * Math.cos(rotation + skewY);
      var b = scaleX * Math.sin(rotation + skewY);
      var c = -scaleY * Math.sin(rotation - skewX);
      var d = scaleY * Math.cos(rotation - skewX);
      return {
        x: nodeX + localX * a + localY * c,
        y: nodeY + localX * b + localY * d
      };
    }

    function manualLocalToStagePoint(node, x, y) {
      var point = { x: x, y: y };
      var current = node;
      var Laya = findLaya();
      var stage = Laya && Laya.stage;
      var guard = 0;
      while (current && guard < 80) {
        if (current === stage) break;
        point = transformPointByNode(current, point);
        current = nodeParent(current);
        guard += 1;
      }
      return point;
    }

    function createLayaPoint(Laya, x, y) {
      try {
        if (Laya && typeof Laya.Point === "function") return new Laya.Point(x, y);
      } catch (error) {}
      return { x: x, y: y };
    }

    function localToStagePoint(node, x, y, Laya) {
      var manualPoint = manualLocalToStagePoint(node, x, y);
      var point = createLayaPoint(Laya, x, y);
      try {
        if (typeof node.localToGlobal === "function") {
          var globalPoint = node.localToGlobal(point);
          if (globalPoint && Number.isFinite(Number(globalPoint.x)) && Number.isFinite(Number(globalPoint.y))) {
            var ownOnlyX = nodeOwnNumber(node, ["x", "_x"], 0) + x;
            var ownOnlyY = nodeOwnNumber(node, ["y", "_y"], 0) + y;
            var parent = nodeParent(node);
            var looksOwnOnly = parent &&
              closeEnough(globalPoint.x, ownOnlyX) &&
              closeEnough(globalPoint.y, ownOnlyY) &&
              (!closeEnough(manualPoint.x, ownOnlyX) || !closeEnough(manualPoint.y, ownOnlyY));
            if (!looksOwnOnly) {
              return {
                x: safeNumber(globalPoint.x, manualPoint.x),
                y: safeNumber(globalPoint.y, manualPoint.y)
              };
            }
          }
        }
      } catch (error) {}
      return manualPoint;
    }

    function nodeLocalSize(node) {
      if (!node) return null;
      var width = safeNumber(node.width, 0);
      var height = safeNumber(node.height, 0);
      var localX = 0;
      var localY = 0;
      if ((!width || !height) && typeof node.getBounds === "function") {
        try {
          var bounds = node.getBounds();
          localX = safeNumber(bounds && bounds.x, 0);
          localY = safeNumber(bounds && bounds.y, 0);
          width = width || safeNumber(bounds && bounds.width, 0);
          height = height || safeNumber(bounds && bounds.height, 0);
        } catch (error) {}
      }
      if (!width || !height) return null;
      return { x: localX, y: localY, width: width, height: height };
    }

    function nodeStageBounds(node) {
      var size = nodeLocalSize(node);
      if (!size) return null;
      var Laya = findLaya();
      var corners = [
        localToStagePoint(node, size.x, size.y, Laya),
        localToStagePoint(node, size.x + size.width, size.y, Laya),
        localToStagePoint(node, size.x + size.width, size.y + size.height, Laya),
        localToStagePoint(node, size.x, size.y + size.height, Laya)
      ];
      var left = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      var right = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      var top = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
      var bottom = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
      return {
        left: left,
        top: top,
        width: right - left,
        height: bottom - top
      };
    }

    function nodeGlobalBounds(node) {
      var size = nodeLocalSize(node);
      if (!size) return null;
      var Laya = findLaya();
      var canvas = findLayaCanvas(Laya);
      var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      var map = stageClientMap(Laya && Laya.stage, canvas, rect);
      var corners = [
        localToStagePoint(node, size.x, size.y, Laya),
        localToStagePoint(node, size.x + size.width, size.y, Laya),
        localToStagePoint(node, size.x + size.width, size.y + size.height, Laya),
        localToStagePoint(node, size.x, size.y + size.height, Laya)
      ].map(function (point) {
        return stagePointToClient(point, map);
      });
      var left = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      var right = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      var top = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
      var bottom = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
      return {
        left: left,
        top: top,
        width: right - left,
        height: bottom - top
      };
    }

    function drawStageHighlight(Laya, node) {
      var overlay = ensureStageHighlightOverlay(Laya);
      var bounds = nodeStageBounds(node);
      if (!overlay || !bounds || !bounds.width || !bounds.height || !overlay.graphics) return false;
      try {
        overlay.visible = true;
        if (typeof overlay.pos === "function") {
          overlay.pos(bounds.left, bounds.top);
        } else {
          overlay.x = bounds.left;
          overlay.y = bounds.top;
        }
        overlay.zOrder = 2147483647;
        if (typeof overlay.graphics.clear === "function") overlay.graphics.clear();
        if (typeof overlay.graphics.drawRect === "function") {
          overlay.graphics.drawRect(0, 0, Math.max(1, bounds.width), Math.max(1, bounds.height), null, "#ff2f3f", 2);
        }
        return true;
      } catch (error) {
        hideStageHighlightOverlay();
        return false;
      }
    }

    function updateHighlightOverlay() {
      state.highlightLooping = false;
      var highlight = window.__LayaProfilerHighlight;
      if (!highlight || !highlight.enabled || !highlight.path) {
        ensureHighlightOverlay().style.display = "none";
        hideStageHighlightOverlay();
        return;
      }
      var engine = detectEngine();
      var node = findNodeByPath(highlight.path);
      var hidden = !node || node.visible === false || node.activeInHierarchy === false;
      if (hidden) {
        ensureHighlightOverlay().style.display = "none";
        hideStageHighlightOverlay();
        return;
      }
      if (engine.type !== "cocos" && drawStageHighlight(engine.Laya, node)) {
        ensureHighlightOverlay().style.display = "none";
        startHighlightOverlayLoop();
        return;
      }
      var overlay = ensureHighlightOverlay();
      var bounds = engine.type === "cocos" ? nodeCocosGlobalBounds(node, engine.cc) : nodeGlobalBounds(node);
      if (!bounds || !bounds.width || !bounds.height) {
        overlay.style.display = "none";
        hideStageHighlightOverlay();
        return;
      }
      hideStageHighlightOverlay();
      overlay.style.display = "block";
      overlay.style.left = bounds.left + "px";
      overlay.style.top = bounds.top + "px";
      overlay.style.width = Math.max(1, bounds.width) + "px";
      overlay.style.height = Math.max(1, bounds.height) + "px";
      startHighlightOverlayLoop();
    }

    function startHighlightOverlayLoop() {
      if (state.highlightLooping) return;
      state.highlightLooping = true;
      requestAnimationFrame(updateHighlightOverlay);
    }

    function findNodeByPath(path) {
      var root = getEngineRoot();
      if (!root || !path) return null;
      if (path === "0") return root;
      var parts = String(path).split(".");
      var node = root;
      for (var index = 1; index < parts.length; index += 1) {
        var childIndex = Number(parts[index]);
        if (!Number.isFinite(childIndex)) return null;
        var children = getChildren(node);
        node = children[childIndex];
        if (!node) return null;
      }
      return node;
    }

    function gpuSummary(resources, deviceTotal) {
      var buckets = {};
      var known = 0;
      resources.forEach(function (resource) {
        var bytes = safeNumber(resource.bytes, 0);
        known += bytes;
        var bucket = resource.type || "Unknown";
        if (!buckets[bucket]) {
          buckets[bucket] = {
            name: bucket,
            bytes: 0,
            resources: []
          };
        }
        buckets[bucket].bytes += bytes;
        buckets[bucket].resources.push({
          name: resource.name || "-",
          url: resource.url || "",
          source: resource.source || "",
          type: resource.type || "Unknown",
          size: resource.size || "-",
          bytes: bytes
        });
      });
      var reported = safeNumber(deviceTotal, 0);
      var total = reported > known ? reported : known;
      return {
        total: total,
        known: known,
        unknown: Math.max(0, total - known),
        count: resources.length,
        buckets: Object.keys(buckets).sort().map(function (name) {
          var bucket = buckets[name];
          bucket.resources.sort(function (a, b) {
            return safeNumber(b.bytes, 0) - safeNumber(a.bytes, 0);
          });
          return bucket;
        })
      };
    }

    function runtimeLabelOf(engine) {
      if (engine.type === "laya") return "LayaAir " + layaRuntimeVersion(engine.Laya);
      if (engine.type === "cocos") return "Cocos Creator " + (cocosRuntimeVersion(engine.cc) || "3.8");
      return "未检测到 LayaAir / Cocos Creator";
    }

    function collect() {
      var engine = detectEngine();
      var counters = { count: 0, sprite: 0 };
      var root = getEngineRoot(engine);
      var tree = root ? walkNode(root, 0, "0", new WeakSet(), counters, engine) : null;
      var resources = collectResources(engine);
      var stats = collectStats(engine, counters.count, counters.sprite, resources);
      return {
        ok: true,
        time: Date.now(),
        detected: engine.type !== "none",
        engine: engine.type,
        runtimeLabel: runtimeLabelOf(engine),
        timerScale: readTimerScale(engine),
        nodes: tree,
        config: collectConfig(),
        resources: resources,
        gpu: gpuSummary(resources, stats.gpuDevice),
        state: collectRuntimeState(engine),
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

    function setCocosTimeScale(cc, scale) {
      try {
        var scheduler = cc && cc.director && typeof cc.director.getScheduler === "function" ? cc.director.getScheduler() : null;
        if (scheduler && typeof scheduler.setTimeScale === "function") scheduler.setTimeScale(scale);
      } catch (error) {}
    }

    function releaseCocosUnusedAssets(cc) {
      if (cc && cc.assetManager && typeof cc.assetManager.releaseUnusedAssets === "function") {
        cc.assetManager.releaseUnusedAssets();
        return;
      }
      if (!cc || !cc.assetManager || typeof cc.assetManager.releaseAsset !== "function") return;
      var pending = [];
      eachCache(cc.assetManager.assets, function (key, asset) {
        try {
          if (asset && safeNumber(asset.refCount, -1) === 0) pending.push(asset);
        } catch (error) {}
      });
      pending.forEach(function (asset) {
        try {
          cc.assetManager.releaseAsset(asset);
        } catch (error) {}
      });
    }

    function setCocosNodeVec(node, kind, axis, value) {
      var current = kind === "position" ? node.position : kind === "scale" ? node.scale : node.eulerAngles;
      var fallback = kind === "scale" ? 1 : 0;
      var x = readVecAxis(current, "x", fallback);
      var y = readVecAxis(current, "y", fallback);
      var z = readVecAxis(current, "z", fallback);
      if (axis === "x") x = value;
      if (axis === "y") y = value;
      if (axis === "z") z = value;
      if (kind === "position" && typeof node.setPosition === "function") node.setPosition(x, y, z);
      else if (kind === "scale" && typeof node.setScale === "function") node.setScale(x, y, z);
      else if (kind === "euler" && typeof node.setRotationFromEuler === "function") node.setRotationFromEuler(x, y, z);
    }

    function setCocosNodeProperty(node, property, value, cc) {
      if (property === "name") node.name = String(value);
      else if (property === "active" || property === "visible") node.active = !!value;
      else if (property === "x") setCocosNodeVec(node, "position", "x", value);
      else if (property === "y") setCocosNodeVec(node, "position", "y", value);
      else if (property === "z") setCocosNodeVec(node, "position", "z", value);
      else if (property === "scaleX") setCocosNodeVec(node, "scale", "x", value);
      else if (property === "scaleY") setCocosNodeVec(node, "scale", "y", value);
      else if (property === "scaleZ") setCocosNodeVec(node, "scale", "z", value);
      else if (property === "eulerX") setCocosNodeVec(node, "euler", "x", value);
      else if (property === "eulerY") setCocosNodeVec(node, "euler", "y", value);
      else if (property === "eulerZ") setCocosNodeVec(node, "euler", "z", value);
      else if (property === "rotation") {
        if ("angle" in node) node.angle = value;
        else setCocosNodeVec(node, "euler", "z", value);
      } else if (property === "width" || property === "height" || property === "pivotX" || property === "pivotY") {
        var ui = getCocosComponent(node, cc, ["UITransform"]);
        if (!ui) return { ok: false, message: "节点没有 UITransform" };
        if (property === "width") ui.width = value;
        if (property === "height") ui.height = value;
        if (property === "pivotX") ui.anchorX = value;
        if (property === "pivotY") ui.anchorY = value;
      } else if (property === "alpha" || property === "opacity") {
        var opacityComp = getCocosComponent(node, cc, ["UIOpacity"]);
        if (!opacityComp) return { ok: false, message: "节点没有 UIOpacity" };
        opacityComp.opacity = property === "alpha" ? Math.max(0, Math.min(255, value * 255)) : value;
      } else if (property === "layer") {
        node.layer = value;
      } else if (property === "zOrder") {
        if (typeof node.setSiblingIndex === "function") node.setSiblingIndex(value);
        else return { ok: false, message: "节点不支持 siblingIndex" };
      } else {
        return { ok: false, message: "不可编辑属性: " + property };
      }
      return { ok: true, message: property + " = " + value };
    }

    function command(name) {
      if (name === "clearConsole" || name && name.type === "clearConsole") {
        state.logs = [];
        return { ok: true, message: "控制台日志已清除" };
      }
      if (name && name.type === "reloadWorkerConfig") {
        try {
          if (typeof window.RELOAD_WORKER_CONFIG !== "function") {
            return { ok: false, message: "window.RELOAD_WORKER_CONFIG 不存在" };
          }
          window.RELOAD_WORKER_CONFIG();
          return { ok: true, message: "已调用 window.RELOAD_WORKER_CONFIG()" };
        } catch (error) {
          return { ok: false, message: error.message || String(error) };
        }
      }
      if (name && name.type === "getGameConfigData") {
        var configTable = getGameConfigTable(name.table);
        if (!configTable) return { ok: false, message: "未找到配置表: " + name.table };
        var tableData = configTable.data;
        if (!tableData || typeof tableData !== "object") return { ok: false, message: name.table + ".data 不存在" };
        return {
          ok: true,
          table: name.table,
          count: configDataCount(tableData),
          data: cloneGameConfigData(tableData, 12)
        };
      }
      if (name && name.type === "setGameConfigValue") {
        var table = getGameConfigTable(name.table);
        if (!table) return { ok: false, message: "未找到配置表: " + name.table };
        var data = table.data;
        if (!data || typeof data !== "object") return { ok: false, message: name.table + ".data 不存在" };
        var path = Array.isArray(name.path) ? name.path : [];
        if (!path.length) return { ok: false, message: "配置路径为空" };
        var target = gameConfigValueAtPath(data, path, false);
        if (!target || !target.target) return { ok: false, message: "未找到配置字段: " + path.join(".") };
        target.target[target.key] = name.value;
        return {
          ok: true,
          message: name.table + ".data." + path.join(".") + " = " + JSON.stringify(name.value),
          value: cloneGameConfigData(target.target[target.key], 4)
        };
      }
      if (name && name.type === "spliceGameConfigArray") {
        var arrayTable = getGameConfigTable(name.table);
        if (!arrayTable) return { ok: false, message: "未找到配置表: " + name.table };
        var arrayData = arrayTable.data;
        if (!arrayData || typeof arrayData !== "object") return { ok: false, message: name.table + ".data 不存在" };
        var arrayPath = Array.isArray(name.path) ? name.path : [];
        var arrayValue = arrayPath.length ? getLocalValueAtPath(arrayData, arrayPath) : arrayData;
        if (!Array.isArray(arrayValue)) return { ok: false, message: "目标不是数组: " + arrayPath.join(".") };
        var op = String(name.op || "");
        var index = Math.max(0, Math.min(arrayValue.length, safeNumber(name.index, arrayValue.length)));
        if (op === "add") {
          var source = arrayValue.length ? arrayValue[Math.max(0, index - 1)] : null;
          arrayValue.splice(index, 0, cloneGameConfigData(source, 12));
        } else if (op === "delete") {
          if (!arrayValue.length) return { ok: false, message: "数组已为空" };
          arrayValue.splice(Math.max(0, Math.min(arrayValue.length - 1, index)), 1);
        } else {
          return { ok: false, message: "未知数组操作: " + op };
        }
        return {
          ok: true,
          message: name.table + ".data." + arrayPath.join(".") + " 数组已更新",
          value: cloneGameConfigData(arrayValue, 12)
        };
      }

      var engine = detectEngine();
      var Laya = engine.Laya;
      var cc = engine.cc;
      if (engine.type === "none") return { ok: false, message: "未检测到 LayaAir / Cocos Creator 运行时" };
      try {
        if (name === "toggleStat") {
          if (engine.type === "cocos" && cc && cc.profiler) {
            var showing = typeof cc.profiler.isShowingStats === "function" ? cc.profiler.isShowingStats() : state.statVisible;
            if (showing && typeof cc.profiler.hideStats === "function") {
              cc.profiler.hideStats();
              state.statVisible = false;
            } else if (typeof cc.profiler.showStats === "function") {
              cc.profiler.showStats();
              state.statVisible = true;
            }
            return { ok: true, message: state.statVisible ? "Profiler 面板已显示" : "Profiler 面板已隐藏" };
          }
          state.statVisible = !state.statVisible;
          if (state.statVisible && Laya && Laya.Stat && typeof Laya.Stat.show === "function") {
            Laya.Stat.show(0, 0);
          } else if (!state.statVisible && Laya && Laya.Stat && typeof Laya.Stat.hide === "function") {
            Laya.Stat.hide();
          }
          return { ok: true, message: state.statVisible ? "Stat 面板已显示" : "Stat 面板已隐藏" };
        }
        if (name === "gc") {
          if (engine.type === "cocos") {
            releaseCocosUnusedAssets(cc);
          } else if (Laya && Laya.Resource && typeof Laya.Resource.destroyUnusedResources === "function") {
            Laya.Resource.destroyUnusedResources();
          }
          if (window.gc) window.gc();
          return { ok: true, message: "已请求资源回收" };
        }
        if (name === "pauseGame") {
          if (engine.type === "cocos") {
            setCocosTimeScale(cc, 0);
            return { ok: true, message: "cc.director.getScheduler().setTimeScale(0)" };
          }
          if (Laya && Laya.timer) Laya.timer.scale = 0;
          return { ok: true, message: "Laya.timer.scale = 0" };
        }
        if (name === "resumeGame") {
          if (engine.type === "cocos") {
            setCocosTimeScale(cc, 1);
            return { ok: true, message: "cc.director.getScheduler().setTimeScale(1)" };
          }
          if (Laya && Laya.timer) Laya.timer.scale = 1;
          return { ok: true, message: "Laya.timer.scale = 1" };
        }
        if (name && name.type === "setTimeScale") {
          var scale = safeNumber(name.value, 1);
          if (engine.type === "cocos") {
            setCocosTimeScale(cc, scale);
            return { ok: true, message: "cc.director.getScheduler().setTimeScale(" + scale + ")" };
          }
          if (Laya && Laya.timer) Laya.timer.scale = scale;
          return { ok: true, message: "Laya.timer.scale = " + scale };
        }
        if (name && name.type === "highlightNode") {
          window.__LayaProfilerHighlight = {
            enabled: !!name.enabled,
            path: name.path || ""
          };
          startHighlightOverlayLoop();
          return { ok: true, message: window.__LayaProfilerHighlight.enabled ? "已开启节点标记" : "已关闭节点标记" };
        }
        if (name && name.type === "setNodeVisible") {
          var node = findNodeByPath(name.path);
          if (!node) return { ok: false, message: "未找到节点: " + name.path };
          if (engine.type === "cocos") {
            node.active = !!name.visible;
            return { ok: true, message: (node.name || typeName(node)) + " active = " + node.active };
          }
          node.visible = !!name.visible;
          return { ok: true, message: (node.name || typeName(node)) + " visible = " + node.visible };
        }
        if (name && name.type === "outputNodeToConsole") {
          var consoleNode = findNodeByPath(name.path);
          if (!consoleNode) return { ok: false, message: "未找到节点: " + name.path };
          window.$layaProfilerNode = consoleNode;
          console.log("输出的节点数据", consoleNode);
          return { ok: true, message: "已输出节点到控制台: " + (consoleNode.name || typeName(consoleNode)) };
        }
        if (name && name.type === "setNodeProperty") {
          var targetNode = findNodeByPath(name.path);
          if (!targetNode) return { ok: false, message: "未找到节点: " + name.path };
          var property = String(name.property || "");
          var editable = {
            name: "string",
            active: "boolean",
            visible: "boolean",
            mouseEnabled: "boolean",
            mouseThrough: "boolean",
            x: "number",
            y: "number",
            z: "number",
            width: "number",
            height: "number",
            pivotX: "number",
            pivotY: "number",
            scaleX: "number",
            scaleY: "number",
            scaleZ: "number",
            skewX: "number",
            skewY: "number",
            rotation: "number",
            eulerX: "number",
            eulerY: "number",
            eulerZ: "number",
            alpha: "number",
            opacity: "number",
            zOrder: "number",
            layer: "number"
          };
          if (!editable[property]) return { ok: false, message: "不可编辑属性: " + property };
          var nextValue = name.value;
          if (editable[property] === "number") nextValue = safeNumber(nextValue, targetNode[property] || 0);
          if (editable[property] === "boolean") nextValue = !!nextValue;
          if (editable[property] === "string") nextValue = String(nextValue == null ? "" : nextValue);
          if (engine.type === "cocos") return setCocosNodeProperty(targetNode, property, nextValue, cc);
          targetNode[property] = nextValue;
          if (property === "name" && targetNode.$owner) targetNode.$owner.name = nextValue;
          return { ok: true, message: property + " = " + nextValue };
        }
        return { ok: false, message: "未知命令: " + name };
      } catch (error) {
        return { ok: false, message: error.message || String(error) };
      }
    }

    hookConsole();
    hookWebGLDrawCalls();
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
