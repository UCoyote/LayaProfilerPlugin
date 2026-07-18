(function () {
  var snapshot = null;
  var activeTab = "nodes";
  var paused = false;
  var selectedNodePath = null;
  var nodeIndex = {};
  var monitorHistory = [];
  var imagePreview = document.getElementById("imagePreview");

  var tabs = Array.from(document.querySelectorAll(".tab"));
  var panels = {
    nodes: document.getElementById("nodesPanel"),
    config: document.getElementById("configPanel"),
    dev: document.getElementById("devPanel"),
    resources: document.getElementById("resourcesPanel"),
    gpu: document.getElementById("gpuPanel"),
    state: document.getElementById("statePanel"),
    frame: document.getElementById("framePanel"),
    console: document.getElementById("consolePanel"),
    monitor: document.getElementById("monitorPanel")
  };

  function $(id) {
    return document.getElementById(id);
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / 1024 / 1024).toFixed(2) + " MB";
  }

  function formatNumber(value, digits) {
    var next = Number(value);
    if (!Number.isFinite(next)) return "--";
    return next.toFixed(digits || 0);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pretty(value) {
    return JSON.stringify(value, null, 2);
  }

  function evalInPage(expression) {
    return new Promise(function (resolve) {
      chrome.devtools.inspectedWindow.eval(expression, { useContentScriptContext: false }, function (result, exceptionInfo) {
        if (exceptionInfo && exceptionInfo.isException) {
          resolve({ ok: false, error: exceptionInfo.value || exceptionInfo.description });
          return;
        }
        resolve({ ok: true, value: result });
      });
    });
  }

  async function ensureInspector() {
    var source = "(" + window.installLayaProfiler.toString() + ")()";
    return evalInPage(source);
  }

  async function collectSnapshot() {
    if (paused) return;
    var installed = await ensureInspector();
    if (!installed.ok) {
      setStatus("注入失败: " + installed.error, true);
      return;
    }
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.collect()");
    if (!result.ok || !result.value) {
      setStatus("采样失败: " + (result.error || "页面未响应"), true);
      return;
    }
    snapshot = result.value;
    if (snapshot.monitor) {
      monitorHistory.push({
        time: Date.now(),
        fps: Number(snapshot.monitor.fps) || 0,
        frameTime: Number(snapshot.monitor.frameTime) || 0,
        heapUsed: Number(snapshot.monitor.heapUsed) || 0,
        gpuMemory: Number(snapshot.monitor.gpuMemory) || 0,
        drawCall: Number(snapshot.monitor.drawCall) || 0
      });
      if (monitorHistory.length > 120) monitorHistory.shift();
    }
    render();
  }

  function setStatus(text, isError) {
    $("statusText").textContent = text;
    $("statusText").classList.toggle("error", !!isError);
    $("lastUpdate").textContent = new Date().toLocaleTimeString();
  }

  function selectTab(name) {
    activeTab = name;
    tabs.forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].classList.toggle("active", key === name);
    });
    render();
  }

  function render() {
    if (!snapshot) return;
    $("runtimeLabel").textContent = snapshot.runtimeLabel || "未知运行时";
    $("metricFps").textContent = formatNumber(snapshot.monitor.fps, 0);
    $("metricFrame").textContent = formatNumber(snapshot.monitor.frameTime, 1) + " ms";
    $("metricHeap").textContent = formatBytes(snapshot.monitor.heapUsed);
    $("metricGpu").textContent = formatBytes(snapshot.monitor.gpuMemory);
    $("metricDraw").textContent = formatNumber(snapshot.monitor.drawCall, 0);
    $("metricNode").textContent = formatNumber(snapshot.monitor.node, 0);
    setStatus(snapshot.detected ? "已连接 Laya 运行时" : "当前页面未检测到 Laya", !snapshot.detected);

    if (activeTab === "nodes") renderNodes();
    if (activeTab === "config") renderKeyValues("configGrid", snapshot.config);
    if (activeTab === "resources") renderResources();
    if (activeTab === "gpu") renderGpu();
    if (activeTab === "state") renderKeyValues("stateGrid", snapshot.state);
    if (activeTab === "frame") renderFrame();
    if (activeTab === "console") renderConsole();
    if (activeTab === "monitor") renderMonitor();
  }

  function getQuery() {
    return $("searchInput").value.trim().toLowerCase();
  }

  function matchesQuery(value) {
    var query = getQuery();
    if (!query) return true;
    return JSON.stringify(value).toLowerCase().includes(query);
  }

  function flattenNodes(node, depth, rows) {
    if (!node) return;
    nodeIndex[node.path] = node;
    if (matchesQuery(node)) rows.push({ node: node, depth: depth });
    (node.children || []).forEach(function (child) {
      flattenNodes(child, depth + 1, rows);
    });
  }

  function renderNodes() {
    var tree = $("nodeTree");
    nodeIndex = {};
    if (!snapshot.nodes) {
      tree.innerHTML = '<div class="empty">未检测到 Laya.stage</div>';
      $("nodeDetail").textContent = "页面中存在 Laya 后会显示节点属性。";
      return;
    }
    var rows = [];
    flattenNodes(snapshot.nodes, 0, rows);
    tree.innerHTML = rows.map(function (row) {
      var node = row.node;
      var selected = selectedNodePath === node.path ? " selected" : "";
      var hidden = node.visible ? "" : " muted";
      return '<button class="tree-row depth-' + Math.min(row.depth, 32) + selected + hidden + '" data-path="' + escapeHtml(node.path) + '" type="button">' +
        '<span class="twisty">' + (node.childCount ? "▸" : "") + '</span>' +
        '<span class="node-name">' + escapeHtml(node.name) + '</span>' +
        '<span class="node-type">' + escapeHtml(node.type) + '</span>' +
        '</button>';
    }).join("") || '<div class="empty">没有匹配的节点</div>';

    var detail = selectedNodePath && nodeIndex[selectedNodePath] ? nodeIndex[selectedNodePath] : snapshot.nodes;
    $("nodeDetail").textContent = pretty(detail);
  }

  function renderKeyValues(targetId, data) {
    var entries = Object.keys(data || {});
    $(targetId).innerHTML = entries.map(function (key) {
      var value = data[key];
      var text = typeof value === "object" ? pretty(value) : String(value);
      return '<article class="kv-item">' +
        '<span>' + escapeHtml(key) + '</span>' +
        '<pre>' + escapeHtml(text) + '</pre>' +
      '</article>';
    }).join("") || '<div class="empty">暂无数据</div>';
  }

  function renderResources() {
    var rows = (snapshot.resources || []).filter(matchesQuery);
    $("resourceRows").innerHTML = rows.map(function (item) {
      var preview = item.previewUrl
        ? '<button class="resource-thumb has-preview" data-preview-url="' + escapeHtml(item.previewUrl) + '" data-preview-name="' + escapeHtml(item.name) + '" data-preview-meta="' + escapeHtml(item.size + " · " + item.type + " · GPU " + formatBytes(item.bytes)) + '" type="button"><img src="' + escapeHtml(item.previewUrl) + '" alt=""></button>'
        : '<span class="resource-thumb empty-thumb"></span>';
      return '<tr>' +
        '<td class="preview-cell">' + preview + '</td>' +
        '<td title="' + escapeHtml(item.url) + '">' + escapeHtml(item.name) + '</td>' +
        '<td>' + escapeHtml(item.source) + '</td>' +
        '<td>' + formatBytes(item.bytes) + '</td>' +
        '<td>' + escapeHtml(item.type) + '</td>' +
        '<td>' + escapeHtml(item.size) + '</td>' +
        '<td class="' + (item.refCount === 0 ? 'idle-ref' : '') + '">' + escapeHtml(item.refText == null ? "-" : item.refText) + '</td>' +
      '</tr>';
    }).join("") || '<tr><td colspan="7" class="empty">暂无资源数据</td></tr>';
  }

  function showImagePreview(target, event) {
    if (!target || !target.dataset.previewUrl) return;
    $("imagePreviewImg").src = target.dataset.previewUrl;
    $("imagePreviewName").textContent = target.dataset.previewName || "图片资源";
    $("imagePreviewMeta").textContent = target.dataset.previewMeta || "";
    imagePreview.classList.add("visible");
    moveImagePreview(event);
  }

  function moveImagePreview(event) {
    if (!imagePreview.classList.contains("visible")) return;
    var padding = 18;
    var rect = imagePreview.getBoundingClientRect();
    var left = event.clientX + padding;
    var top = event.clientY + padding;
    if (left + rect.width > window.innerWidth - 8) {
      left = event.clientX - rect.width - padding;
    }
    if (top + rect.height > window.innerHeight - 8) {
      top = window.innerHeight - rect.height - 8;
    }
    imagePreview.style.left = Math.max(8, left) + "px";
    imagePreview.style.top = Math.max(8, top) + "px";
  }

  function hideImagePreview() {
    imagePreview.classList.remove("visible");
    $("imagePreviewImg").removeAttribute("src");
  }

  function renderGpu() {
    $("gpuTotal").textContent = formatBytes(snapshot.gpu.total);
    $("gpuKnown").textContent = formatBytes(snapshot.gpu.known);
    $("gpuUnknown").textContent = formatBytes(snapshot.gpu.unknown);
    $("gpuCount").textContent = snapshot.gpu.count;
    var total = Math.max(snapshot.gpu.total, 1);
    $("gpuBuckets").innerHTML = (snapshot.gpu.buckets || []).map(function (bucket) {
      var width = Math.min(100, Math.max(2, Math.round(bucket.bytes / total * 100)));
      return '<article class="bucket">' +
        '<div><strong>' + escapeHtml(bucket.name) + '</strong><span>' + formatBytes(bucket.bytes) + '</span></div>' +
        '<span class="bar"><i class="w-' + width + '"></i></span>' +
      '</article>';
    }).join("") || '<div class="empty">暂无 GPU 对象</div>';
  }

  function renderFrame() {
    renderKeyValues("frameGrid", snapshot.frame.stats || {});
    drawChart($("frameChart"), snapshot.frame.samples || [], [
      { key: "fps", color: "#57c7ff", label: "FPS" },
      { key: "frameTime", color: "#ffcc66", label: "FrameTime" }
    ]);
  }

  function renderConsole() {
    var rows = (snapshot.console || []).filter(matchesQuery).slice(-200);
    $("consoleRows").innerHTML = rows.map(function (row) {
      return '<div class="console-row ' + escapeHtml(row.level) + '">' +
        '<span>' + new Date(row.time).toLocaleTimeString() + '</span>' +
        '<strong>' + escapeHtml(row.level) + '</strong>' +
        '<code>' + escapeHtml(row.message) + '</code>' +
      '</div>';
    }).join("") || '<div class="empty">暂无控制台日志</div>';
  }

  function renderMonitor() {
    renderKeyValues("monitorGrid", {
      FPS: formatNumber(snapshot.monitor.fps, 0),
      FrameTime: formatNumber(snapshot.monitor.frameTime, 2) + " ms",
      HeapUsed: formatBytes(snapshot.monitor.heapUsed),
      GPUMemory: formatBytes(snapshot.monitor.gpuMemory),
      DrawCall: formatNumber(snapshot.monitor.drawCall, 0),
      Node: formatNumber(snapshot.monitor.node, 0),
      Sprite: formatNumber(snapshot.monitor.sprite, 0),
      Triangle: formatNumber(snapshot.monitor.triangle, 0),
      ShaderCall: formatNumber(snapshot.monitor.shaderCall, 0)
    });
    drawChart($("monitorChart"), monitorHistory, [
      { key: "fps", color: "#57c7ff", label: "FPS" },
      { key: "frameTime", color: "#ffcc66", label: "FrameTime" },
      { key: "drawCall", color: "#7ee787", label: "DrawCall" }
    ]);
  }

  function drawChart(canvas, rows, series) {
    var context = canvas.getContext("2d");
    var width = canvas.width;
    var height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#181c24";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#2b3342";
    context.lineWidth = 1;
    for (var grid = 1; grid < 4; grid += 1) {
      var y = Math.round(height * grid / 4);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    if (!rows.length) return;

    series.forEach(function (serie, serieIndex) {
      var max = rows.reduce(function (top, row) {
        return Math.max(top, Number(row[serie.key]) || 0);
      }, 1);
      context.strokeStyle = serie.color;
      context.lineWidth = 2;
      context.beginPath();
      rows.forEach(function (row, index) {
        var x = rows.length === 1 ? width : index / (rows.length - 1) * width;
        var value = Number(row[serie.key]) || 0;
        var y = height - value / max * (height - 24) - 12;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      context.fillStyle = serie.color;
      context.fillText(serie.label, 12 + serieIndex * 88, 18);
    });
  }

  async function runCommand(command) {
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify(command) + ")");
    var value = result.value || result;
    $("devOutput").textContent = pretty(value);
    collectSnapshot();
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      selectTab(tab.dataset.tab);
    });
  });

  $("nodeTree").addEventListener("click", function (event) {
    var row = event.target.closest(".tree-row");
    if (!row) return;
    selectedNodePath = row.dataset.path;
    renderNodes();
  });

  $("searchInput").addEventListener("input", render);
  $("refreshBtn").addEventListener("click", collectSnapshot);
  $("pauseBtn").addEventListener("click", function () {
    paused = !paused;
    $("pauseBtn").textContent = paused ? "继续" : "暂停";
    setStatus(paused ? "已暂停采样" : "已恢复采样", false);
    if (!paused) collectSnapshot();
  });

  document.querySelector(".dev-actions").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-command]");
    if (button) runCommand(button.dataset.command);
  });

  $("resourceRows").addEventListener("mouseover", function (event) {
    var target = event.target.closest(".has-preview");
    if (target) showImagePreview(target, event);
  });

  $("resourceRows").addEventListener("mousemove", moveImagePreview);

  $("resourceRows").addEventListener("mouseout", function (event) {
    var target = event.target.closest(".has-preview");
    if (target && !target.contains(event.relatedTarget)) hideImagePreview();
  });

  collectSnapshot();
  setInterval(collectSnapshot, 1000);
})();
