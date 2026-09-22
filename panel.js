(function () {
  var snapshot = null;
  var activeMainTab = "nodes";
  var activeBottomTab = null;
  var paused = false;
  var selectedNodePath = null;
  var expandedNodePaths = { "0": true };
  var nodeIndex = {};
  var nodeHighlightEnabled = false;
  var lastNonZeroTimeScale = 1;
  var monitorHistory = [];
  var imagePreview = document.getElementById("imagePreview");
  var resourceSort = { key: "bytes", dir: "desc" };
  var resourceSnapshots = [];
  var selectedResourceSnapshotId = null;
  var compareSnapshotIds = [];
  var resourceCompareResult = null;
  var selectedConfigTable = null;
  var selectedConfigData = null;
  var configDataLoading = false;
  var expandedConfigPaths = { "[]": true };
  var configInitialDataByTable = {};
  var configModifiedMap = {};
  var configTemplates = [];
  var selectedConfigTemplateId = null;
  var showingConfigChanges = false;
  var selectedConfigRows = [];
  var configVirtualScrollTop = 0;
  var configVirtualRowHeight = 32;
  var expandedGpuBuckets = {};
  var dockedTabs = {};
  var draggedTab = null;
  var bottomDockHeight = 240;
  var tabLabels = {};
  var consoleLevelFilter = "all";
  var expandedConsoleStacks = {};

  var mainTabsElement = document.getElementById("mainTabs");
  var mainContentElement = document.getElementById("mainContent");
  var bottomDockElement = document.getElementById("bottomDock");
  var bottomTabsElement = document.getElementById("bottomTabs");
  var bottomDockContentElement = document.getElementById("bottomDockContent");
  var bottomDockResizer = document.getElementById("bottomDockResizer");
  var tabs = Array.from(document.querySelectorAll("#mainTabs .tab"));
  var panels = {
    nodes: document.getElementById("nodesPanel"),
    config: document.getElementById("configPanel"),
    dev: document.getElementById("devPanel"),
    resources: document.getElementById("resourcesPanel"),
    gpu: document.getElementById("gpuPanel"),
    console: document.getElementById("consolePanel"),
    monitor: document.getElementById("monitorPanel")
  };
  tabs.forEach(function (tab) {
    tabLabels[tab.dataset.tab] = tab.textContent.trim();
  });

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
    render({ skipResourcePanel: true });
  }

  function setStatus(text, isError) {
    $("statusText").textContent = text;
    $("statusText").classList.toggle("error", !!isError);
    $("lastUpdate").textContent = new Date().toLocaleTimeString();
  }

  function selectTab(name, location) {
    if (location === "bottom") {
      activeBottomTab = name;
    } else {
      activeMainTab = name;
    }
    updatePanelVisibility();
    render();
  }

  function tabLocation(name) {
    return dockedTabs[name] ? "bottom" : "main";
  }

  function dockedTabNames() {
    return Object.keys(dockedTabs).filter(function (name) {
      return !!dockedTabs[name];
    });
  }

  function mainTabNames() {
    return Object.keys(panels).filter(function (name) {
      return !dockedTabs[name];
    });
  }

  function firstTab(names, fallback) {
    return names.length ? names[0] : fallback;
  }

  function updatePanelVisibility() {
    tabs.forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.tab === activeMainTab && tabLocation(tab.dataset.tab) === "main");
      tab.classList.toggle("docked", tabLocation(tab.dataset.tab) === "bottom");
    });
    Array.from(bottomTabsElement.querySelectorAll(".tab")).forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.tab === activeBottomTab);
    });
    Object.keys(panels).forEach(function (key) {
      var location = tabLocation(key);
      var active = location === "bottom" ? key === activeBottomTab : key === activeMainTab;
      panels[key].classList.toggle("active", active);
    });
  }

  function renderPanel(name, options) {
    if (!name) return;
    if (name === "nodes" && !isEditingNodeInspector()) renderNodes();
    if (name === "config" && !isInteractingGameConfig()) renderGameConfig();
    if (name === "resources" && !options.skipResourcePanel) renderResources();
    if (name === "gpu") renderGpu();
    if (name === "console") renderConsole();
    if (name === "monitor") renderMonitor();
  }

  function renderBottomTabs() {
    var names = dockedTabNames();
    bottomDockElement.classList.toggle("empty", !names.length);
    bottomDockElement.style.setProperty("--bottom-dock-height", bottomDockHeight + "px");
    bottomTabsElement.innerHTML = names.map(function (name) {
      return '<button class="tab" data-tab="' + escapeHtml(name) + '" type="button" draggable="true">' + escapeHtml(tabLabels[name] || name) + '</button>';
    }).join("");
    bottomDockElement.classList.toggle("has-content", !!names.length);
  }

  function movePanelToLocation(name, location) {
    var panel = panels[name];
    if (!panel) return;
    if (location === "bottom") {
      bottomDockContentElement.appendChild(panel);
    } else {
      mainContentElement.appendChild(panel);
    }
  }

  function dockTab(name) {
    if (!panels[name] || dockedTabs[name]) return;
    dockedTabs[name] = true;
    movePanelToLocation(name, "bottom");
    activeBottomTab = name;
    if (activeMainTab === name) {
      activeMainTab = firstTab(mainTabNames(), null);
    }
    renderBottomTabs();
    updatePanelVisibility();
    render();
  }

  function undockTab(name) {
    if (!panels[name] || !dockedTabs[name]) return;
    delete dockedTabs[name];
    movePanelToLocation(name, "main");
    activeMainTab = name;
    if (activeBottomTab === name) {
      activeBottomTab = firstTab(dockedTabNames(), null);
    }
    renderBottomTabs();
    updatePanelVisibility();
    render();
  }

  function canDockFromEvent(event) {
    var rect = bottomDockElement.getBoundingClientRect();
    return event.clientY >= rect.top - 48;
  }

  function updateDockDropState(active) {
    bottomDockElement.classList.toggle("drop-target", !!active);
  }

  function render(options) {
    options = options || {};
    if (!snapshot) return;
    $("runtimeLabel").textContent = snapshot.runtimeLabel || "未知运行时";
    $("metricFps").textContent = formatNumber(snapshot.monitor.fps, 0);
    $("metricFrame").textContent = formatNumber(snapshot.monitor.frameTime, 1) + " ms";
    $("metricHeap").textContent = formatBytes(snapshot.monitor.heapUsed);
    $("metricGpu").textContent = formatBytes(snapshot.monitor.gpuMemory);
    $("metricDraw").textContent = formatNumber(snapshot.monitor.drawCall, 0);
    $("metricNode").textContent = formatNumber(snapshot.monitor.node, 0);
    var connected = !!snapshot.detected;
    var statusText = "当前页面未检测到 LayaAir / Cocos Creator";
    if (connected && snapshot.engine === "cocos") statusText = "已连接 Cocos Creator 运行时";
    else if (connected) statusText = "已连接 Laya 运行时";
    setStatus(statusText, !connected);

    renderPanel(activeMainTab, options);
    if (activeBottomTab && activeBottomTab !== activeMainTab) renderPanel(activeBottomTab, options);
  }

  function getQuery() {
    return $("searchInput").value.trim().toLowerCase();
  }

  function getNodeQuery() {
    var input = $("nodeSearchInput");
    return input ? input.value.trim().toLowerCase() : "";
  }

  function matchesQuery(value) {
    var query = getQuery();
    if (!query) return true;
    return JSON.stringify(value).toLowerCase().includes(query);
  }

  function matchesNodeQuery(value) {
    var query = getNodeQuery();
    if (!query) return true;
    return JSON.stringify(value).toLowerCase().includes(query);
  }

  function isEditingNodeInspector() {
    var active = document.activeElement;
    return active && $("nodeDetail") && $("nodeDetail").contains(active) && active.matches("input");
  }

  function isEditingGameConfig() {
    var active = document.activeElement;
    return active && $("configDetail") && $("configDetail").contains(active) && active.matches("input");
  }

  function isInteractingGameConfig() {
    if (isEditingGameConfig()) return true;
    var detail = $("configDetail");
    var list = $("configList");
    return !!((detail && detail.matches(":hover")) || (list && list.matches(":hover")));
  }

  function flattenNodes(node, depth, rows) {
    if (!node) return;
    nodeIndex[node.path] = node;
    if (matchesNodeQuery(node)) rows.push({ node: node, depth: depth });
    var query = getNodeQuery();
    var expanded = expandedNodePaths[node.path] || query;
    if (!expanded) return;
    (node.children || []).forEach(function (child) {
      flattenNodes(child, depth + 1, rows);
    });
  }

  function currentEngine() {
    return snapshot && snapshot.engine ? snapshot.engine : "none";
  }

  function renderNodes() {
    var tree = $("nodeTree");
    nodeIndex = {};
    if (!snapshot.nodes) {
      var emptyTree = "未检测到 LayaAir / Cocos Creator 运行时";
      var emptyDetail = "页面中存在 LayaAir 或 Cocos Creator 后会显示节点属性。";
      if (currentEngine() === "cocos") {
        emptyTree = "未检测到当前场景";
        emptyDetail = "页面存在 cc.director.getScene() 后会显示节点属性。";
      } else if (currentEngine() === "laya") {
        emptyTree = "未检测到 Laya.stage";
        emptyDetail = "页面中存在 Laya 后会显示节点属性。";
      }
      tree.innerHTML = '<div class="empty">' + emptyTree + '</div>';
      $("nodeDetail").textContent = emptyDetail;
      return;
    }
    updateNodeToolbar();
    var rows = [];
    flattenNodes(snapshot.nodes, 0, rows);
    tree.innerHTML = rows.map(function (row) {
      var node = row.node;
      var selected = selectedNodePath === node.path ? " selected" : "";
      var hidden = node.visible ? "" : " muted";
      var expanded = expandedNodePaths[node.path] || getNodeQuery();
      var shown = currentEngine() === "cocos" ? node.active : node.visible;
      var visibleButton = selected
        ? '<button class="tree-visible" data-node-action="visible" type="button" title="' + (shown ? "隐藏节点" : "显示节点") + '">' + (shown ? "◉" : "○") + '</button>'
        : '';
      return '<div class="tree-row depth-' + Math.min(row.depth, 32) + selected + hidden + '" data-path="' + escapeHtml(node.path) + '">' +
        '<button class="tree-toggle" data-node-action="toggle" type="button" title="' + (expanded ? "折叠节点" : "展开节点") + '">' + (node.childCount ? (expanded ? "▾" : "▸") : "") + '</button>' +
        '<button class="tree-select" data-node-action="select" type="button" title="选择节点">' +
        '<span class="node-name">' + escapeHtml(node.name) + '</span>' +
        '<span class="node-type">' + escapeHtml(node.type) + '</span>' +
        '</button>' +
        visibleButton +
        '</div>';
    }).join("") || '<div class="empty">没有匹配的节点</div>';

    var detail = selectedNodePath && nodeIndex[selectedNodePath] ? nodeIndex[selectedNodePath] : snapshot.nodes;
    $("nodeDetail").innerHTML = renderNodeInspector(detail);
  }

  function updateNodeToolbar() {
    var scale = snapshot && Number.isFinite(Number(snapshot.timerScale)) ? Number(snapshot.timerScale) : NaN;
    if (!Number.isFinite(scale) && snapshot && snapshot.state) {
      if (snapshot.state.Stage) scale = Number(snapshot.state.Stage.timerScale);
      else if (snapshot.state.Scene) scale = Number(snapshot.state.Scene.timerScale);
    }
    if (Number.isFinite(scale)) {
      if (scale > 0) lastNonZeroTimeScale = scale;
      if (document.activeElement !== $("nodeTimeScaleInput")) $("nodeTimeScaleInput").value = String(scale);
      $("nodePauseBtn").textContent = scale === 0 ? "▶" : "⏸";
      $("nodePauseBtn").title = scale === 0 ? "恢复游戏" : "暂停游戏";
    }
    $("nodeHighlightBtn").classList.toggle("active", nodeHighlightEnabled);
    $("nodeHighlightBtn").title = nodeHighlightEnabled ? "关闭选中框标记" : "开启选中框标记";
  }

  function renderNodeInspector(node) {
    if (!node) return '<div class="empty">选择左侧节点查看属性</div>';
    if (currentEngine() === "cocos") return renderCocosNodeInspector(node);
    return renderLayaNodeInspector(node);
  }

  function renderLayaNodeInspector(node) {
    return '<div class="node-inspector">' +
      '<section class="inspector-section">' +
        '<header><strong>节点信息</strong><span>NodeInfo</span></header>' +
        inspectorField("名称", "name", node.name, "text") +
        inspectorToggleRow("激活", "active", node.active, "可见", "visible", node.visible) +
        '<button class="inspector-console" data-node-action="console" type="button">输出到控制台</button>' +
      '</section>' +
      '<section class="inspector-section">' +
        '<header><strong>基础</strong><span>Node2D</span></header>' +
        inspectorPair("位置", "X", "x", node.x, "Y", "y", node.y) +
        inspectorPair("尺寸", "X", "width", node.width, "Y", "height", node.height) +
        inspectorPair("锚点", "X", "pivotX", node.pivotX, "Y", "pivotY", node.pivotY) +
        inspectorPair("缩放", "X", "scaleX", node.scaleX, "Y", "scaleY", node.scaleY) +
        inspectorPair("倾斜", "X", "skewX", node.skewX, "Y", "skewY", node.skewY) +
        inspectorField("旋转", "rotation", node.rotation, "number") +
        inspectorToggle("可见", "visible", node.visible) +
        inspectorRange("透明度", "alpha", node.alpha) +
        inspectorToggle("鼠标触摸启用", "mouseEnabled", node.mouseEnabled) +
        inspectorToggle("鼠标触摸穿透", "mouseThrough", node.mouseThrough) +
        inspectorField("zOrder", "zOrder", node.zOrder, "number") +
      '</section>' +
      '<section class="inspector-section">' +
        '<header><strong>调试</strong><span>' + escapeHtml(node.type) + '</span></header>' +
        inspectorReadOnlyField("路径", node.path) +
        inspectorReadOnlyField("子节点", node.childCount) +
        inspectorReadOnlyField("销毁", node.destroyed ? "true" : "false") +
      '</section>' +
    '</div>';
  }

  function renderCocosNodeInspector(node) {
    var components = Array.isArray(node.components) && node.components.length ? node.components.join(", ") : "-";
    return '<div class="node-inspector">' +
      '<section class="inspector-section">' +
        '<header><strong>节点信息</strong><span>Node</span></header>' +
        inspectorField("名称", "name", node.name, "text") +
        inspectorToggle("激活", "active", node.active) +
        '<button class="inspector-console" data-node-action="console" type="button">输出到控制台</button>' +
      '</section>' +
      '<section class="inspector-section">' +
        '<header><strong>变换</strong><span>Transform</span></header>' +
        inspectorTriple("位置", "X", "x", node.x, "Y", "y", node.y, "Z", "z", node.z) +
        inspectorTriple("缩放", "X", "scaleX", node.scaleX, "Y", "scaleY", node.scaleY, "Z", "scaleZ", node.scaleZ) +
        inspectorTriple("欧拉角", "X", "eulerX", node.eulerX, "Y", "eulerY", node.eulerY, "Z", "eulerZ", node.eulerZ) +
        inspectorField("2D 角度", "rotation", node.rotation, "number") +
      '</section>' +
      '<section class="inspector-section">' +
        '<header><strong>UI</strong><span>UITransform</span></header>' +
        inspectorPair("尺寸", "W", "width", node.width, "H", "height", node.height) +
        inspectorPair("锚点", "X", "pivotX", node.pivotX, "Y", "pivotY", node.pivotY) +
        inspectorRange("透明度", "alpha", node.alpha) +
      '</section>' +
      '<section class="inspector-section">' +
        '<header><strong>调试</strong><span>' + escapeHtml(node.type) + '</span></header>' +
        inspectorReadOnlyField("路径", node.path) +
        inspectorReadOnlyField("UUID", node.uuid || "-") +
        inspectorField("Layer", "layer", node.layer, "number") +
        inspectorField("Sibling", "zOrder", node.zOrder, "number") +
        inspectorReadOnlyField("组件", components) +
        inspectorReadOnlyField("子节点", node.childCount) +
        inspectorReadOnlyField("销毁", node.destroyed ? "true" : "false") +
      '</section>' +
    '</div>';
  }

  function inspectorField(label, property, value, type) {
    var inputType = type === "text" ? "text" : "number";
    return '<label class="inspector-field"><span>' + escapeHtml(label) + '</span><input data-node-property="' + escapeHtml(property) + '" type="' + inputType + '" value="' + escapeHtml(value) + '"></label>';
  }

  function inspectorReadOnlyField(label, value) {
    return '<label class="inspector-field readonly"><span>' + escapeHtml(label) + '</span><input value="' + escapeHtml(value) + '" readonly></label>';
  }

  function inspectorPair(label, aLabel, aProperty, aValue, bLabel, bProperty, bValue) {
    return '<div class="inspector-pair"><span>' + escapeHtml(label) + '</span>' +
      '<label><em>' + escapeHtml(aLabel) + '</em><input data-node-property="' + escapeHtml(aProperty) + '" type="number" value="' + escapeHtml(aValue) + '"></label>' +
      '<label><em>' + escapeHtml(bLabel) + '</em><input data-node-property="' + escapeHtml(bProperty) + '" type="number" value="' + escapeHtml(bValue) + '"></label>' +
      '</div>';
  }

  function inspectorTriple(label, aLabel, aProperty, aValue, bLabel, bProperty, bValue, cLabel, cProperty, cValue) {
    return '<div class="inspector-pair inspector-triple"><span>' + escapeHtml(label) + '</span>' +
      '<label><em>' + escapeHtml(aLabel) + '</em><input data-node-property="' + escapeHtml(aProperty) + '" type="number" value="' + escapeHtml(aValue) + '"></label>' +
      '<label><em>' + escapeHtml(bLabel) + '</em><input data-node-property="' + escapeHtml(bProperty) + '" type="number" value="' + escapeHtml(bValue) + '"></label>' +
      '<label><em>' + escapeHtml(cLabel) + '</em><input data-node-property="' + escapeHtml(cProperty) + '" type="number" value="' + escapeHtml(cValue) + '"></label>' +
      '</div>';
  }

  function inspectorToggle(label, property, value) {
    return '<button class="inspector-toggle" data-node-property="' + escapeHtml(property) + '" data-node-boolean="' + (value ? "true" : "false") + '" type="button"><span>' + escapeHtml(label) + '</span><i class="' + (value ? "on" : "") + '">' + (value ? "✓" : "") + '</i></button>';
  }

  function inspectorToggleRow(leftLabel, leftProperty, leftValue, rightLabel, rightProperty, rightValue) {
    return '<div class="inspector-toggle-row">' +
      inspectorToggle(leftLabel, leftProperty, leftValue) +
      inspectorToggle(rightLabel, rightProperty, rightValue) +
      '</div>';
  }

  function inspectorRange(label, property, value) {
    var percent = Math.max(0, Math.min(100, Number(value) * 100 || 0));
    return '<div class="inspector-range"><span>' + escapeHtml(label) + '</span><input data-node-property="' + escapeHtml(property) + '" type="range" min="0" max="1" step="0.01" value="' + escapeHtml(value) + '"><input data-node-property="' + escapeHtml(property) + '" type="number" min="0" max="1" step="0.01" value="' + escapeHtml(value) + '"></div>';
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

  function configTables() {
    return snapshot && snapshot.config && Array.isArray(snapshot.config.tables) ? snapshot.config.tables : [];
  }

  function configPathKey(path) {
    return JSON.stringify(path || []);
  }

  function valueKind(value) {
    if (Array.isArray(value)) return "Array";
    if (value === null) return "null";
    return typeof value === "object" ? "Object" : typeof value;
  }

  function configChildCount(value) {
    if (!value || typeof value !== "object") return 0;
    return Object.keys(value).length;
  }

  function configTableQuery() {
    var input = $("configTableSearchInput");
    var local = input ? input.value.trim().toLowerCase() : "";
    return local || getQuery();
  }

  function configDataQuery() {
    var input = $("configDataSearchInput");
    return input ? input.value.trim().toLowerCase() : "";
  }

  function configValueText(value) {
    if (typeof value === "string") return value;
    if (value == null || typeof value !== "object") return String(value);
    return pretty(value);
  }

  function cloneConfigValue(value) {
    if (value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map(cloneConfigValue);
    }
    var output = {};
    Object.keys(value).forEach(function (key) {
      output[key] = cloneConfigValue(value[key]);
    });
    return output;
  }

  function configValuesEqual(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch (error) {
      return left === right;
    }
  }

  function getLocalConfigValue(data, path) {
    var current = data;
    for (var index = 0; index < path.length; index += 1) {
      if (!current || typeof current !== "object") return undefined;
      current = current[path[index]];
    }
    return current;
  }

  function configArrayAncestorPath(data, path) {
    var current = data;
    var arrayPath = null;
    for (var index = 0; index < path.length; index += 1) {
      if (Array.isArray(current)) arrayPath = path.slice(0, index);
      if (!current || typeof current !== "object") return arrayPath;
      current = current[path[index]];
    }
    if (Array.isArray(current)) arrayPath = path.slice();
    return arrayPath;
  }

  function configChangeId(table, path) {
    return table + "::" + configPathKey(path);
  }

  function configPathText(path) {
    return path.map(function (part) {
      return String(part);
    }).join(".");
  }

  function updateConfigChange(table, path, currentValue) {
    var initial = configInitialDataByTable[table];
    if (!initial) return;
    var originalValue = getLocalConfigValue(initial, path);
    var id = configChangeId(table, path);
    if (configValuesEqual(originalValue, currentValue)) {
      delete configModifiedMap[id];
      return;
    }
    configModifiedMap[id] = {
      id: id,
      table: table,
      path: path.slice(),
      pathText: configPathText(path),
      original: cloneConfigValue(originalValue),
      current: cloneConfigValue(currentValue),
      time: Date.now()
    };
  }

  function clearConfigChangesUnderPath(table, path) {
    Object.keys(configModifiedMap).forEach(function (id) {
      var change = configModifiedMap[id];
      if (!change || change.table !== table) return;
      var sameRoot = path.every(function (part, index) {
        return change.path[index] === part;
      });
      if (sameRoot && change.path.length > path.length) delete configModifiedMap[id];
    });
  }

  function modifiedConfigList() {
    return Object.keys(configModifiedMap).map(function (key) {
      return configModifiedMap[key];
    }).sort(function (a, b) {
      return b.time - a.time;
    });
  }

  function renderGameConfig() {
    var config = snapshot && snapshot.config;
    updateConfigChangesButton();
    if (showingConfigChanges) {
      renderConfigChanges();
      return;
    }
    var tables = configTables().filter(function (table) {
      var query = configTableQuery();
      return !query || table.name.toLowerCase().includes(query);
    });
    var list = $("configList");
    var detail = $("configDetail");
    if (!config || !config.detected) {
      selectedConfigTable = null;
      selectedConfigData = null;
      list.innerHTML = '<div class="empty">未检测到全局 config 对象</div>';
      detail.innerHTML = '<div class="empty">页面存在 window.config 后会显示配置表。</div>';
      return;
    }
    if (!configTables().length) {
      selectedConfigTable = null;
      selectedConfigData = null;
      list.innerHTML = '<div class="empty">未找到后缀为 Tbs 的配置表</div>';
      detail.innerHTML = '<div class="empty">会遍历 window.config 中名称以 Tbs 结尾的成员。</div>';
      return;
    }
    if (!selectedConfigTable || !configTables().some(function (table) { return table.name === selectedConfigTable; })) {
      selectedConfigTable = configTables()[0].name;
      selectedConfigData = null;
      expandedConfigPaths = { "[]": true };
    }
    list.innerHTML = tables.map(function (table) {
      var selected = table.name === selectedConfigTable ? " selected" : "";
      var muted = table.hasData ? "" : " muted";
      return '<button class="config-row' + selected + muted + '" data-config-table="' + escapeHtml(table.name) + '" type="button">' +
        '<span class="config-name">' + escapeHtml(table.name) + '</span>' +
        '<span class="config-meta">' + escapeHtml(table.count) + ' 条 · ' + escapeHtml(table.type) + '</span>' +
      '</button>';
    }).join("") || '<div class="empty">没有匹配的配置表</div>';

    if (!selectedConfigData || selectedConfigData.table !== selectedConfigTable) {
      detail.innerHTML = '<div class="empty">正在读取 ' + escapeHtml(selectedConfigTable) + '.data...</div>';
      loadSelectedConfigData(selectedConfigTable);
      return;
    }

    var selectedMeta = configTables().find(function (table) {
      return table.name === selectedConfigTable;
    });
    selectedConfigRows = buildConfigRows(selectedConfigData.data);
    detail.innerHTML = '<div class="config-detail-head">' +
      '<strong>' + escapeHtml(selectedConfigTable) + '</strong>' +
      '<span>' + escapeHtml(selectedConfigRows.length) + ' 行 · ' + escapeHtml(selectedMeta ? selectedMeta.count : selectedConfigData.count) + ' 条</span>' +
    '</div>' +
    '<div id="configVirtualList" class="config-data-virtual">' +
      '<div class="config-virtual-spacer" style="height:' + (selectedConfigRows.length * configVirtualRowHeight) + 'px">' +
        '<div id="configVirtualRows" class="config-virtual-rows"></div>' +
      '</div>' +
    '</div>';
    var viewport = $("configVirtualList");
    if (viewport) {
      viewport.scrollTop = Math.min(configVirtualScrollTop, Math.max(0, selectedConfigRows.length * configVirtualRowHeight - viewport.clientHeight));
    }
    renderConfigVirtualRows();
  }

  async function loadSelectedConfigData(table) {
    if (!table || configDataLoading) return;
    configDataLoading = true;
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "getGameConfigData",
      table: table
    }) + ")");
    configDataLoading = false;
    var value = result.value || result;
    if (value && value.ok && value.table === selectedConfigTable) {
      selectedConfigData = value;
      if (!configInitialDataByTable[value.table]) {
        configInitialDataByTable[value.table] = cloneConfigValue(value.data);
      }
    } else {
      selectedConfigData = {
        ok: false,
        table: table,
        data: value && value.message ? value.message : "读取失败"
      };
    }
    renderGameConfig();
  }

  function buildConfigRows(data) {
    var query = configDataQuery();

    function visit(label, value, path, depth, forceVisible, parentIsArray) {
      var kind = valueKind(value);
      var hasChildren = value && typeof value === "object";
      var pathText = configPathText(path);
      var ownText = (pathText + " " + label + " " + kind + (hasChildren ? "" : " " + configValueText(value))).toLowerCase();
      var ownMatch = !query || ownText.includes(query);
      var key = configPathKey(path);
      var childRows = [];
      if (hasChildren) {
        Object.keys(value).forEach(function (childKey) {
          childRows = childRows.concat(visit(childKey, value[childKey], path.concat([childKey]), depth + 1, forceVisible || ownMatch, Array.isArray(value)));
        });
      }
      var childMatch = childRows.length > 0;
      if (!query || ownMatch || childMatch || forceVisible) {
        var row = {
          label: label,
          value: value,
          kind: kind,
          path: path,
          pathKey: key,
          pathText: pathText,
          depth: depth,
          hasChildren: hasChildren,
          childCount: configChildCount(value),
          expanded: !!expandedConfigPaths[key],
          modified: !!configModifiedMap[configChangeId(selectedConfigTable, path)],
          parentIsArray: !!parentIsArray
        };
        if (hasChildren && (expandedConfigPaths[key] || query)) {
          return [row].concat(childRows);
        }
        return [row];
      }
      return [];
    }

    var rows = [];
    if (!data || typeof data !== "object") {
      rows = visit("data", data, [], 0, false, false);
    } else {
      Object.keys(data).forEach(function (key) {
        rows = rows.concat(visit(key, data[key], [key], 0, false, Array.isArray(data)));
      });
    }
    return rows;
  }

  function renderConfigVirtualRows() {
    var viewport = $("configVirtualList");
    var target = $("configVirtualRows");
    if (!viewport || !target) return;
    configVirtualScrollTop = viewport.scrollTop;
    var height = viewport.clientHeight || 420;
    var start = Math.max(0, Math.floor(configVirtualScrollTop / configVirtualRowHeight) - 8);
    var end = Math.min(selectedConfigRows.length, Math.ceil((configVirtualScrollTop + height) / configVirtualRowHeight) + 8);
    target.style.transform = "translateY(" + (start * configVirtualRowHeight) + "px)";
    target.innerHTML = selectedConfigRows.slice(start, end).map(function (row, offset) {
      return renderConfigRow(row, start + offset);
    }).join("") || '<div class="empty">没有匹配的配置数据</div>';
  }

  function renderConfigRow(row, index) {
    var indent = Math.min(row.depth, 24);
    var modified = row.modified ? " modified" : "";
    var actions = renderConfigRowActions(row);
    if (row.hasChildren) {
      return '<div class="config-node virtual-row' + modified + '" style="--depth:' + indent + '" data-config-index="' + index + '">' +
        '<div class="config-node-head" data-config-path="' + escapeHtml(row.pathKey) + '" role="button" tabindex="0">' +
          '<span class="config-twisty">' + (row.expanded || configDataQuery() ? "▾" : "▸") + '</span>' +
          '<strong title="' + escapeHtml(row.pathText) + '">' + escapeHtml(row.label) + '</strong>' +
          '<em>' + escapeHtml(row.kind) + ' · ' + row.childCount + '</em>' +
          actions +
        '</div>' +
      '</div>';
    }
    return '<div class="config-leaf virtual-row' + modified + '" style="--depth:' + indent + '" data-config-index="' + index + '">' +
      '<span title="' + escapeHtml(row.pathText) + '">' + escapeHtml(row.label) + '</span>' +
      renderConfigInput(row.value, row.path, row.kind) +
      actions +
    '</div>';
  }

  function renderConfigRowActions(row) {
    var html = "";
    if (row.kind === "Array") {
      html += '<button class="config-array-action" data-config-array-action="add" data-config-path="' + escapeHtml(row.pathKey) + '" data-config-index="' + row.childCount + '" type="button" title="增加数组条目">+</button>';
    }
    if (row.parentIsArray && row.path.length) {
      var parentPath = row.path.slice(0, -1);
      var itemIndex = Number(row.path[row.path.length - 1]);
      html += '<button class="config-array-action danger" data-config-array-action="delete" data-config-path="' + escapeHtml(configPathKey(parentPath)) + '" data-config-index="' + escapeHtml(itemIndex) + '" type="button" title="删除数组条目">×</button>';
    }
    return '<span class="config-row-actions">' + html + '</span>';
  }

  function renderConfigInput(value, path, kind) {
    var pathValue = escapeHtml(configPathKey(path));
    if (kind === "boolean") {
      return '<button class="config-value-toggle" data-config-path="' + pathValue + '" data-config-kind="boolean" data-config-value="' + (value ? "true" : "false") + '" type="button">' + (value ? "true" : "false") + '</button>';
    }
    if (kind === "number") {
      return '<input data-config-path="' + pathValue + '" data-config-kind="number" type="number" value="' + escapeHtml(value) + '">';
    }
    if (kind === "string") {
      return '<input data-config-path="' + pathValue + '" data-config-kind="string" type="text" value="' + escapeHtml(value) + '">';
    }
    return '<input data-config-path="' + pathValue + '" data-config-kind="json" type="text" value="' + escapeHtml(pretty(value)) + '">';
  }

  function parseConfigPath(value) {
    try {
      var path = JSON.parse(value || "[]");
      return Array.isArray(path) ? path : [];
    } catch (error) {
      return [];
    }
  }

  function configInputValue(input) {
    var kind = input.dataset.configKind;
    if (kind === "number") {
      var number = Number(input.value);
      return Number.isFinite(number) ? number : 0;
    }
    if (kind === "boolean") return input.dataset.configValue === "true";
    if (kind === "json") {
      try {
        return JSON.parse(input.value);
      } catch (error) {
        return input.value;
      }
    }
    return input.value;
  }

  function setLocalConfigValue(path, value) {
    if (!selectedConfigData || !selectedConfigData.data || !path.length) return;
    var current = selectedConfigData.data;
    for (var index = 0; index < path.length - 1; index += 1) {
      current = current && current[path[index]];
      if (!current || typeof current !== "object") return;
    }
    current[path[path.length - 1]] = value;
  }

  function setLocalConfigPathValue(path, value) {
    if (!selectedConfigData) return;
    if (!path.length) {
      selectedConfigData.data = value;
      return;
    }
    setLocalConfigValue(path, value);
  }

  async function setGameConfigValue(path, value) {
    if (!selectedConfigTable || !path.length) return;
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "setGameConfigValue",
      table: selectedConfigTable,
      path: path,
      value: value
    }) + ")");
    var response = result.value || result;
    if (response && response.ok) {
      setLocalConfigValue(path, value);
      var arrayPath = configArrayAncestorPath(selectedConfigData.data, path);
      var changePath = arrayPath || path;
      var changeValue = arrayPath ? getLocalConfigValue(selectedConfigData.data, arrayPath) : value;
      if (arrayPath) clearConfigChangesUnderPath(selectedConfigTable, arrayPath);
      updateConfigChange(selectedConfigTable, changePath, changeValue);
      setStatus(response.message || "配置已更新", false);
    } else {
      setStatus(response && response.message ? response.message : "配置更新失败", true);
    }
    updateConfigChangesButton();
    renderGameConfig();
  }

  async function spliceGameConfigArray(path, index, op) {
    if (!selectedConfigTable) return;
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "spliceGameConfigArray",
      table: selectedConfigTable,
      path: path,
      index: index,
      op: op
    }) + ")");
    var response = result.value || result;
    if (response && response.ok) {
      setLocalConfigPathValue(path, response.value);
      clearConfigChangesUnderPath(selectedConfigTable, path);
      updateConfigChange(selectedConfigTable, path, response.value);
      setStatus(response.message || "数组已更新", false);
    } else {
      setStatus(response && response.message ? response.message : "数组更新失败", true);
    }
    updateConfigChangesButton();
    renderGameConfig();
  }

  async function reloadWorkerConfig() {
    var installed = await ensureInspector();
    if (!installed.ok) {
      setStatus("注入失败: " + installed.error, true);
      return;
    }
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "reloadWorkerConfig"
    }) + ")");
    var response = result.value || result;
    if (response && response.ok) {
      selectedConfigData = null;
      setStatus(response.message || "已重载 Worker 配置", false);
      await collectSnapshot();
    } else {
      setStatus(response && response.message ? response.message : "重载 Worker 配置失败", true);
    }
  }

  function updateConfigChangesButton() {
    var button = $("configChangesBtn");
    if (!button) return;
    var count = modifiedConfigList().length;
    button.textContent = showingConfigChanges ? "返回数据" : "修改列表" + (count ? " (" + count + ")" : "");
    button.classList.toggle("active", showingConfigChanges || count > 0);
  }

  function renderConfigChanges() {
    var list = $("configList");
    var detail = $("configDetail");
    var config = snapshot && snapshot.config;
    if (list && config && config.detected) {
      var query = configTableQuery();
      var tables = configTables().filter(function (table) {
        return !query || table.name.toLowerCase().includes(query);
      });
      list.innerHTML = tables.map(function (table) {
        var selected = table.name === selectedConfigTable ? " selected" : "";
        return '<button class="config-row' + selected + '" data-config-table="' + escapeHtml(table.name) + '" type="button">' +
          '<span class="config-name">' + escapeHtml(table.name) + '</span>' +
          '<span class="config-meta">' + escapeHtml(table.count) + ' 条 · ' + escapeHtml(table.type) + '</span>' +
        '</button>';
      }).join("") || '<div class="empty">没有匹配的配置表</div>';
    }
    var changes = modifiedConfigList();
    var template = selectedConfigTemplate();
    var previewRows = template ? template.changes : changes;
    detail.innerHTML = '<div class="config-detail-head">' +
      '<strong>运行时修改</strong>' +
      '<span>' + (template ? "模板 " + template.name + " · " + template.changes.length + " 项" : changes.length + " 项") + '</span>' +
    '</div>' +
    renderConfigTemplateToolbar(changes.length) +
    '<div class="config-changes">' + previewRows.map(renderConfigChangeRow).join("") + '</div>';
    if (!previewRows.length) {
      detail.innerHTML = '<div class="config-detail-head"><strong>运行时修改</strong><span>0 项</span></div>' +
        renderConfigTemplateToolbar(changes.length) +
        '<div class="empty">' + (template ? "该模板暂无修改项" : "暂无修改记录") + '</div>';
    }
    updateConfigChangesButton();
  }

  function renderConfigTemplateToolbar(changeCount) {
    return '<div class="config-template-toolbar">' +
      '<button id="saveConfigTemplateBtn" type="button" ' + (changeCount ? "" : "disabled") + '>保存当前修改为模板</button>' +
      '<select id="configTemplateSelect">' +
        '<option value="">选择模板预览</option>' +
        configTemplates.map(function (template) {
          return '<option value="' + escapeHtml(template.id) + '"' + (template.id === selectedConfigTemplateId ? " selected" : "") + '>' + escapeHtml(template.name) + '</option>';
        }).join("") +
      '</select>' +
      '<button id="applyConfigTemplateBtn" type="button" ' + (selectedConfigTemplateId ? "" : "disabled") + '>应用模板</button>' +
    '</div>';
  }

  function selectedConfigTemplate() {
    return configTemplates.find(function (template) {
      return template.id === selectedConfigTemplateId;
    }) || null;
  }

  function saveConfigTemplate() {
    var changes = modifiedConfigList();
    if (!changes.length) {
      setStatus("当前没有可保存的配置修改", true);
      return;
    }
    var name = window.prompt("请输入模板名称", "配置修改模板 " + (configTemplates.length + 1));
    if (!name) return;
    var template = {
      id: "config-template-" + Date.now(),
      name: name,
      createdAt: Date.now(),
      changes: changes.map(function (change) {
        return {
          table: change.table,
          path: change.path.slice(),
          pathText: change.pathText,
          original: cloneConfigValue(change.original),
          current: cloneConfigValue(change.current),
          time: change.time
        };
      })
    };
    configTemplates.unshift(template);
    selectedConfigTemplateId = template.id;
    setStatus("已保存配置修改模板: " + name, false);
    renderConfigChanges();
  }

  async function applyConfigTemplate() {
    var template = selectedConfigTemplate();
    if (!template) return;
    for (var index = 0; index < template.changes.length; index += 1) {
      var change = template.changes[index];
      var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
        type: "setGameConfigValue",
        table: change.table,
        path: change.path,
        value: change.current
      }) + ")");
      var response = result.value || result;
      if (!response || !response.ok) {
        setStatus(response && response.message ? response.message : "应用模板失败", true);
        return;
      }
      if (selectedConfigData && selectedConfigData.table === change.table) {
        setLocalConfigPathValue(change.path, change.current);
        updateConfigChange(change.table, change.path, change.current);
      } else {
        configModifiedMap[configChangeId(change.table, change.path)] = {
          id: configChangeId(change.table, change.path),
          table: change.table,
          path: change.path.slice(),
          pathText: change.pathText,
          original: cloneConfigValue(change.original),
          current: cloneConfigValue(change.current),
          time: Date.now()
        };
      }
    }
    setStatus("已应用配置模板: " + template.name, false);
    renderConfigChanges();
  }

  function renderConfigChangeRow(change) {
    var changeId = change.id || configChangeId(change.table, change.path || []);
    return '<article class="config-change-row" data-config-change-id="' + escapeHtml(changeId) + '">' +
      '<header>' +
        '<strong>' + escapeHtml(change.table) + '</strong>' +
        '<span>' + escapeHtml(change.pathText) + '</span>' +
      '</header>' +
      '<div class="config-change-values">' +
        '<pre>' + escapeHtml(configValueText(change.original)) + '</pre>' +
        '<pre>' + escapeHtml(configValueText(change.current)) + '</pre>' +
      '</div>' +
    '</article>';
  }

  function renderResources() {
    renderResourceSnapshotList();
    panels.resources.classList.toggle("compare-mode", !!resourceCompareResult);
    if (resourceCompareResult) {
      $("resourceSnapshotTitle").textContent = resourceCompareResult.title;
      var compareRows = sortResources((resourceCompareResult.rows || []).filter(matchesQuery));
      $("resourceRows").innerHTML = compareRows.map(renderResourceRow).join("") || '<tr><td colspan="8" class="empty">没有匹配的差异资源</td></tr>';
      updateSortButtons();
      return;
    }

    var selectedSnapshot = getSelectedResourceSnapshot();
    if (resourceSort.key === "changeType") {
      resourceSort = { key: "bytes", dir: "desc" };
    }
    $("resourceSnapshotTitle").textContent = selectedSnapshot
      ? selectedSnapshot.title + " · " + selectedSnapshot.count + " 个资源 · GPU " + formatBytes(selectedSnapshot.gpuMemory)
      : "点击“快照”保存当前资源状态";
    if (!selectedSnapshot) {
      $("resourceRows").innerHTML = '<tr><td colspan="7" class="empty">暂无快照。点击左侧录制按钮后，再选择快照查看资源列表。</td></tr>';
      updateSortButtons();
      return;
    }

    var rows = sortResources((selectedSnapshot.resources || []).filter(matchesQuery));
    $("resourceRows").innerHTML = rows.map(renderResourceRow).join("") || '<tr><td colspan="7" class="empty">暂无资源数据</td></tr>';
    updateSortButtons();
  }

  function renderResourceRow(item) {
    var previewMeta = item.size + " · " + item.type + " · GPU " + formatBytes(item.bytes);
    if (item.diffDetail) previewMeta += " · " + item.diffDetail;
    var preview = item.previewUrl
      ? '<button class="resource-thumb has-preview" data-preview-kind="image" data-preview-url="' + escapeHtml(item.previewUrl) + '" data-preview-name="' + escapeHtml(item.name) + '" data-preview-meta="' + escapeHtml(previewMeta) + '" type="button"><img src="' + escapeHtml(item.previewUrl) + '" alt=""></button>'
      : '<button class="resource-thumb empty-thumb has-preview" data-preview-kind="none" data-preview-name="' + escapeHtml(item.name) + '" data-preview-meta="' + escapeHtml(previewMeta) + '" type="button"></button>';
    var refCell = item.refCount === 0
      ? '<td class="idle-ref"><span class="idle-dot"></span>空闲</td>'
      : '<td>' + escapeHtml(item.refText == null ? "-" : item.refText) + '</td>';
    return '<tr>' +
      '<td class="preview-cell">' + preview + '</td>' +
      '<td class="change-cell">' + renderChangeBadge(item.changeType, item.changeText) + '</td>' +
      '<td title="' + escapeHtml(item.url) + '">' + escapeHtml(item.name) + '</td>' +
      '<td>' + escapeHtml(item.source) + '</td>' +
      '<td>' + formatBytes(item.bytes) + '</td>' +
      '<td>' + escapeHtml(item.type) + '</td>' +
      '<td>' + escapeHtml(item.size) + '</td>' +
      refCell +
    '</tr>';
  }

  function renderChangeBadge(type, text) {
    if (!type) return '<span class="change-badge neutral">-</span>';
    return '<span class="change-badge ' + escapeHtml(type) + '">' + escapeHtml(text || "-") + '</span>';
  }

  function createResourceSnapshot() {
    if (!snapshot || !snapshot.resources) {
      setStatus("当前还没有可用资源数据", true);
      return;
    }
    var resources = JSON.parse(JSON.stringify(snapshot.resources || []));
    var createdAt = Date.now();
    var id = "resource-snapshot-" + createdAt;
    var gpuMemory = resources.reduce(function (sum, item) {
      return sum + (Number(item.bytes) || 0);
    }, 0);
    var next = {
      id: id,
      title: "快照 " + (resourceSnapshots.length + 1),
      createdAt: createdAt,
      timeText: new Date(createdAt).toLocaleTimeString(),
      count: resources.length,
      gpuMemory: gpuMemory,
      resources: resources
    };
    resourceSnapshots.unshift(next);
    if (resourceSnapshots.length > 30) resourceSnapshots.pop();
    selectedResourceSnapshotId = id;
    resourceCompareResult = null;
    renderResources();
    setStatus("已创建资源快照: " + next.count + " 个资源", false);
  }

  function getSelectedResourceSnapshot() {
    return resourceSnapshots.find(function (item) {
      return item.id === selectedResourceSnapshotId;
    }) || null;
  }

  function renderResourceSnapshotList() {
    var target = $("resourceSnapshotList");
    if (!resourceSnapshots.length) {
      target.innerHTML = '<div class="empty">暂无快照</div>';
      updateCompareButton();
      return;
    }
    target.innerHTML = resourceSnapshots.map(function (item) {
      var active = item.id === selectedResourceSnapshotId ? " active" : "";
      var comparing = compareSnapshotIds.indexOf(item.id) !== -1 ? " comparing" : "";
      var quickCompare = active ? renderQuickCompareSnapshots(item.id) : "";
      return '<article class="snapshot-item' + active + comparing + '" data-snapshot-id="' + escapeHtml(item.id) + '">' +
        '<button class="snapshot-main" data-snapshot-action="select" type="button" title="查看该资源快照">' +
          '<strong>' + escapeHtml(item.title) + '</strong>' +
          '<span>' + escapeHtml(item.timeText) + '</span>' +
          '<small>' + item.count + ' 个资源 · GPU ' + formatBytes(item.gpuMemory) + '</small>' +
        '</button>' +
        '<div class="snapshot-item-actions">' +
          '<button class="icon-button compare-pick-button' + comparing + '" data-snapshot-action="toggle-compare" type="button" title="选择该快照参与比较" aria-label="选择该快照参与比较">✓</button>' +
          '<button class="icon-button delete-snapshot-button" data-snapshot-action="delete" type="button" title="删除该快照" aria-label="删除该快照">×</button>' +
        '</div>' +
        quickCompare +
      '</article>';
    }).join("");
    updateCompareButton();
  }

  function renderQuickCompareSnapshots(baseId) {
    var options = resourceSnapshots.filter(function (item) {
      return item.id !== baseId;
    });
    if (!options.length) return "";
    return '<div class="quick-compare-list">' +
      '<span>快速比较</span>' +
      options.map(function (item) {
        return '<button class="quick-compare-button" data-snapshot-action="quick-compare" data-compare-target-id="' + escapeHtml(item.id) + '" type="button" title="与 ' + escapeHtml(item.title) + ' 比较">' +
          escapeHtml(item.title) +
        '</button>';
      }).join("") +
    '</div>';
  }

  function updateCompareButton() {
    var button = $("compareResourceSnapshotsBtn");
    button.disabled = compareSnapshotIds.length !== 2;
    button.classList.toggle("active", compareSnapshotIds.length === 2);
    button.title = compareSnapshotIds.length === 2 ? "比较选中的两个快照" : "请选择两个快照后比较";
  }

  function toggleCompareSnapshot(id) {
    resourceCompareResult = null;
    var existingIndex = compareSnapshotIds.indexOf(id);
    if (existingIndex !== -1) {
      compareSnapshotIds.splice(existingIndex, 1);
    } else {
      if (compareSnapshotIds.length >= 2) compareSnapshotIds.shift();
      compareSnapshotIds.push(id);
    }
    renderResources();
  }

  function deleteResourceSnapshot(id) {
    resourceSnapshots = resourceSnapshots.filter(function (item) {
      return item.id !== id;
    });
    compareSnapshotIds = compareSnapshotIds.filter(function (itemId) {
      return itemId !== id;
    });
    if (selectedResourceSnapshotId === id) {
      selectedResourceSnapshotId = resourceSnapshots[0] ? resourceSnapshots[0].id : null;
    }
    if (resourceCompareResult && resourceCompareResult.ids.indexOf(id) !== -1) {
      resourceCompareResult = null;
    }
    renderResources();
    setStatus("已删除资源快照", false);
  }

  function compareSelectedResourceSnapshots() {
    if (compareSnapshotIds.length !== 2) {
      setStatus("请选择两个快照后再比较", true);
      return;
    }
    compareResourceSnapshots(compareSnapshotIds[0], compareSnapshotIds[1]);
  }

  function compareResourceSnapshots(leftId, rightId) {
    var left = resourceSnapshots.find(function (item) {
      return item.id === leftId;
    });
    var right = resourceSnapshots.find(function (item) {
      return item.id === rightId;
    });
    if (!left || !right) {
      setStatus("比较失败: 快照不存在", true);
      return;
    }
    compareSnapshotIds = [left.id, right.id];
    resourceCompareResult = buildResourceComparison(left, right);
    renderResources();
    setStatus("已比较资源快照差异", false);
  }

  function buildResourceComparison(left, right) {
    var leftMap = indexResources(left.resources);
    var rightMap = indexResources(right.resources);
    var keys = {};
    Object.keys(leftMap).forEach(function (key) { keys[key] = true; });
    Object.keys(rightMap).forEach(function (key) { keys[key] = true; });

    var summary = { added: 0, removed: 0, changed: 0, same: 0 };
    var rows = Object.keys(keys).map(function (key) {
      var before = leftMap[key];
      var after = rightMap[key];
      if (!before && after) {
        summary.added += 1;
        return Object.assign({}, after, { changeType: "added", changeText: "新增", diffDetail: "新增资源" });
      }
      if (before && !after) {
        summary.removed += 1;
        return Object.assign({}, before, { changeType: "removed", changeText: "移除", diffDetail: "已移除资源" });
      }
      var detail = resourceDiffDetail(before, after);
      if (detail) {
        summary.changed += 1;
        return Object.assign({}, after, { changeType: "changed", changeText: "变化", diffDetail: detail });
      }
      summary.same += 1;
      return Object.assign({}, after, { changeType: "same", changeText: "未变", diffDetail: "未变" });
    });
    return {
      ids: [left.id, right.id],
      title: "比较: " + left.title + " → " + right.title +
        " · 新增 " + summary.added +
        " · 移除 " + summary.removed +
        " · 变化 " + summary.changed +
        " · 未变 " + summary.same,
      rows: rows,
      summary: summary
    };
  }

  function indexResources(resources) {
    var map = {};
    (resources || []).forEach(function (item) {
      map[resourceCompareKey(item)] = item;
    });
    return map;
  }

  function resourceCompareKey(item) {
    return item.url || item.name || String(item.id || "");
  }

  function resourceDiffDetail(before, after) {
    var changes = [];
    if ((Number(before.bytes) || 0) !== (Number(after.bytes) || 0)) {
      changes.push("GPU " + formatBytes(before.bytes) + " → " + formatBytes(after.bytes));
    }
    if ((before.type || "") !== (after.type || "")) {
      changes.push("类型 " + (before.type || "-") + " → " + (after.type || "-"));
    }
    if ((before.size || "") !== (after.size || "")) {
      changes.push("尺寸 " + (before.size || "-") + " → " + (after.size || "-"));
    }
    if ((before.refText || "") !== (after.refText || "")) {
      changes.push("引用 " + (before.refText || "-") + " → " + (after.refText || "-"));
    }
    return changes.join("; ");
  }

  function sortResources(rows) {
    var key = resourceSort.key;
    var dir = resourceSort.dir === "asc" ? 1 : -1;
    return rows.slice().sort(function (left, right) {
      var a = sortableResourceValue(left, key);
      var b = sortableResourceValue(right, key);
      var missingA = a == null || a === "";
      var missingB = b == null || b === "";
      if (missingA && missingB) return 0;
      if (missingA) return 1;
      if (missingB) return -1;
      if (typeof a === "string" || typeof b === "string") {
        return String(a).localeCompare(String(b), "zh-CN", { numeric: true }) * dir;
      }
      return (a - b) * dir;
    });
  }

  function sortableResourceValue(item, key) {
    if (key === "bytes") return Number(item.bytes) || 0;
    if (key === "type") return item.type || "";
    if (key === "changeType") return changeTypeRank(item.changeType);
    if (key === "refCount") return item.refCount == null ? null : Number(item.refCount);
    if (key === "size") {
      var match = String(item.size || "").match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
      return match ? Number(match[1]) * Number(match[2]) : null;
    }
    return "";
  }

  function changeTypeRank(type) {
    var ranks = {
      added: 1,
      removed: 2,
      changed: 3,
      same: 4
    };
    return ranks[type] || null;
  }

  function updateSortButtons() {
    document.querySelectorAll(".sort-btn").forEach(function (button) {
      var active = button.dataset.sortKey === resourceSort.key && button.dataset.sortDir === resourceSort.dir;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function showImagePreview(target, event) {
    if (!target) return;
    var isImage = target.dataset.previewKind === "image" && target.dataset.previewUrl;
    $("imagePreviewImg").classList.toggle("hidden", !isImage);
    $("imagePreviewMessage").classList.toggle("visible", !isImage);
    $("imagePreviewMessage").textContent = isImage ? "" : "当前资源非图片，无法预览";
    if (isImage) {
      $("imagePreviewImg").src = target.dataset.previewUrl;
    } else {
      $("imagePreviewImg").removeAttribute("src");
    }
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
    $("imagePreviewImg").classList.remove("hidden");
    $("imagePreviewMessage").classList.remove("visible");
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
      var expanded = !!expandedGpuBuckets[bucket.name];
      var resources = bucket.resources || [];
      return '<article class="bucket' + (expanded ? " expanded" : "") + '">' +
        '<button class="bucket-head" data-gpu-bucket="' + escapeHtml(bucket.name) + '" type="button" title="展开资源归因">' +
          '<span class="bucket-twisty">' + (expanded ? "▾" : "▸") + '</span>' +
          '<strong>' + escapeHtml(bucket.name) + '</strong>' +
          '<em>' + resources.length + ' 个资源</em>' +
          '<span>' + formatBytes(bucket.bytes) + '</span>' +
        '</button>' +
        '<span class="bar"><i class="w-' + width + '"></i></span>' +
        (expanded ? renderGpuBucketResources(resources) : "") +
      '</article>';
    }).join("") || '<div class="empty">暂无 GPU 对象</div>';
  }

  function renderGpuBucketResources(resources) {
    if (!resources.length) return '<div class="gpu-resource-list"><div class="empty">暂无资源归因</div></div>';
    return '<div class="gpu-resource-list">' +
      resources.map(function (resource) {
        var path = resource.url || resource.source || "-";
        return '<article class="gpu-resource-item">' +
          '<div>' +
            '<strong title="' + escapeHtml(resource.name || "-") + '">' + escapeHtml(resource.name || "-") + '</strong>' +
            '<span title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</span>' +
          '</div>' +
          '<em>' + escapeHtml(resource.size || "-") + '</em>' +
          '<b>' + formatBytes(resource.bytes) + '</b>' +
        '</article>';
      }).join("") +
    '</div>';
  }

  function renderConsole() {
    var queryInput = $("consoleSearchInput");
    var query = queryInput ? queryInput.value.trim().toLowerCase() : "";
    var rows = (snapshot.console || []).filter(function (row) {
      var normalizedLevel = row.level === "info" || row.level === "debug" ? "log" : row.level;
      if (consoleLevelFilter !== "all" && normalizedLevel !== consoleLevelFilter) return false;
      if (!query) return true;
      var stackText = (row.stack || []).map(function (frame) {
        return [frame.fn, frame.url, frame.line].join(" ");
      }).join(" ");
      return (String(row.message || "") + " " + String(row.level || "") + " " + new Date(row.time).toLocaleTimeString() + " " + stackText).toLowerCase().includes(query);
    }).slice(-300);
    $("consoleRows").innerHTML = rows.map(function (row) {
      var level = row.level === "info" || row.level === "debug" ? "log" : row.level;
      var stack = row.stack || [];
      var stackKey = consoleStackKey(row);
      var expanded = !!expandedConsoleStacks[stackKey];
      return '<div class="console-row ' + escapeHtml(level) + (stack.length ? " has-stack" : "") + '">' +
        '<button class="console-stack-toggle" data-console-stack-key="' + escapeHtml(stackKey) + '" type="button" title="' + (expanded ? "折叠调用堆栈" : "展开调用堆栈") + '">' + (stack.length ? (expanded ? "▾" : "▸") : "") + '</button>' +
        '<span class="console-time">' + new Date(row.time).toLocaleTimeString() + '</span>' +
        '<strong>' + escapeHtml(level) + '</strong>' +
        '<div class="console-message">' +
          '<code>' + escapeHtml(row.message) + '</code>' +
          (expanded ? renderConsoleStack(stack) : "") +
        '</div>' +
      '</div>';
    }).join("") || '<div class="empty">暂无控制台日志</div>';
  }

  function consoleStackKey(row) {
    return [row.time, row.level, row.message].join("|");
  }

  function sourceName(url) {
    var text = String(url || "");
    var clean = text.split("?")[0].split("#")[0];
    var parts = clean.split("/");
    return parts[parts.length - 1] || text || "-";
  }

  function renderConsoleStack(stack) {
    if (!stack || !stack.length) return "";
    return '<div class="console-stack">' + stack.map(function (frame) {
      return '<div class="console-stack-frame">' +
        '<span class="console-stack-fn">' + escapeHtml(frame.fn || "(anonymous)") + '</span>' +
        '<button class="console-source-link" data-source-url="' + escapeHtml(frame.url) + '" data-source-line="' + escapeHtml(frame.line) + '" data-source-column="' + escapeHtml(frame.column || 0) + '" type="button">' +
          escapeHtml(sourceName(frame.url)) + ':' + escapeHtml(frame.line) +
        '</button>' +
      '</div>';
    }).join("") + '</div>';
  }

  function openConsoleSource(target) {
    var url = target.dataset.sourceUrl;
    var line = Math.max(0, (Number(target.dataset.sourceLine) || 1) - 1);
    var column = Math.max(0, (Number(target.dataset.sourceColumn) || 1) - 1);
    if (!url || !chrome.devtools || !chrome.devtools.panels || typeof chrome.devtools.panels.openResource !== "function") {
      setStatus("当前环境不支持打开 Sources 资源", true);
      return;
    }
    try {
      chrome.devtools.panels.openResource(url, line, column, function () {
        setStatus("已打开源码: " + sourceName(url) + ":" + (line + 1), false);
      });
    } catch (error) {
      try {
        chrome.devtools.panels.openResource(url, line, function () {
          setStatus("已打开源码: " + sourceName(url) + ":" + (line + 1), false);
        });
      } catch (innerError) {
        setStatus(innerError.message || "打开 Sources 失败", true);
      }
    }
  }

  function updateConsoleFilters() {
    document.querySelectorAll(".console-filter").forEach(function (button) {
      button.classList.toggle("active", button.dataset.consoleLevel === consoleLevelFilter);
    });
  }

  async function clearConsoleLogs() {
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify("clearConsole") + ")");
    var response = result.value || result;
    if (response && response.ok) {
      if (snapshot) snapshot.console = [];
      setStatus(response.message || "控制台日志已清除", false);
      renderConsole();
    } else {
      setStatus(response && response.message ? response.message : "清除控制台日志失败", true);
    }
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
      selectTab(tab.dataset.tab, "main");
    });
    tab.addEventListener("dragstart", function (event) {
      draggedTab = tab.dataset.tab;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedTab);
      document.body.classList.add("tab-dragging");
    });
    tab.addEventListener("dragend", function () {
      draggedTab = null;
      document.body.classList.remove("tab-dragging");
      updateDockDropState(false);
    });
  });

  bottomTabsElement.addEventListener("click", function (event) {
    var tab = event.target.closest(".tab[data-tab]");
    if (!tab) return;
    selectTab(tab.dataset.tab, "bottom");
  });

  bottomTabsElement.addEventListener("dragstart", function (event) {
    var tab = event.target.closest(".tab[data-tab]");
    if (!tab) return;
    draggedTab = tab.dataset.tab;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedTab);
    document.body.classList.add("tab-dragging");
  });

  bottomTabsElement.addEventListener("dragend", function () {
    draggedTab = null;
    document.body.classList.remove("tab-dragging");
    updateDockDropState(false);
  });

  [bottomDockElement, bottomTabsElement, bottomDockContentElement].forEach(function (target) {
    target.addEventListener("dragover", function (event) {
      if (!draggedTab) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      updateDockDropState(true);
    });
    target.addEventListener("dragleave", function (event) {
      if (!bottomDockElement.contains(event.relatedTarget)) updateDockDropState(false);
    });
    target.addEventListener("drop", function (event) {
      if (!draggedTab) return;
      event.preventDefault();
      dockTab(draggedTab);
      draggedTab = null;
      document.body.classList.remove("tab-dragging");
      updateDockDropState(false);
    });
  });

  [mainTabsElement, mainContentElement].forEach(function (target) {
    target.addEventListener("dragover", function (event) {
      if (!draggedTab || !dockedTabs[draggedTab]) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    target.addEventListener("drop", function (event) {
      if (!draggedTab || !dockedTabs[draggedTab]) return;
      event.preventDefault();
      undockTab(draggedTab);
      draggedTab = null;
      document.body.classList.remove("tab-dragging");
      updateDockDropState(false);
    });
  });

  document.addEventListener("dragover", function (event) {
    if (!draggedTab || dockedTabs[draggedTab]) return;
    if (canDockFromEvent(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      updateDockDropState(true);
    } else {
      updateDockDropState(false);
    }
  });

  document.addEventListener("drop", function (event) {
    if (!draggedTab || dockedTabs[draggedTab] || !canDockFromEvent(event)) return;
    event.preventDefault();
    dockTab(draggedTab);
    draggedTab = null;
    document.body.classList.remove("tab-dragging");
    updateDockDropState(false);
  });

  bottomDockResizer.addEventListener("pointerdown", function (event) {
    if (!dockedTabNames().length) return;
    event.preventDefault();
    var startY = event.clientY;
    var startHeight = bottomDockHeight;
    var maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.75));
    bottomDockResizer.setPointerCapture(event.pointerId);

    function move(moveEvent) {
      var delta = startY - moveEvent.clientY;
      bottomDockHeight = Math.max(120, Math.min(maxHeight, startHeight + delta));
      bottomDockElement.style.setProperty("--bottom-dock-height", bottomDockHeight + "px");
    }

    function up(upEvent) {
      bottomDockResizer.releasePointerCapture(upEvent.pointerId);
      bottomDockResizer.removeEventListener("pointermove", move);
      bottomDockResizer.removeEventListener("pointerup", up);
      bottomDockResizer.removeEventListener("pointercancel", up);
    }

    bottomDockResizer.addEventListener("pointermove", move);
    bottomDockResizer.addEventListener("pointerup", up);
    bottomDockResizer.addEventListener("pointercancel", up);
  });

  $("nodeTree").addEventListener("click", function (event) {
    var row = event.target.closest(".tree-row");
    if (!row) return;
    var actionTarget = event.target.closest("[data-node-action]");
    var action = actionTarget ? actionTarget.dataset.nodeAction : "select";
    var path = row.dataset.path;
    if (action === "toggle") {
      if (!nodeIndex[path] || !nodeIndex[path].childCount) return;
      expandedNodePaths[path] = !expandedNodePaths[path];
      renderNodes();
      return;
    }
    if (action === "visible") {
      var node = nodeIndex[path];
      if (!node) return;
      var nextVisible = currentEngine() === "cocos" ? !node.active : !node.visible;
      toggleNodeVisible(path, nextVisible);
      return;
    }
    selectedNodePath = path;
    updateSelectedNodeHighlight();
    renderNodes();
  });

  $("searchInput").addEventListener("input", render);
  $("configTableSearchInput").addEventListener("input", function () {
    renderGameConfig();
  });
  $("reloadWorkerConfigBtn").addEventListener("click", reloadWorkerConfig);
  $("configDataSearchInput").addEventListener("input", function () {
    configVirtualScrollTop = 0;
    renderGameConfig();
  });
  $("configChangesBtn").addEventListener("click", function () {
    showingConfigChanges = !showingConfigChanges;
    renderGameConfig();
  });
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

  document.querySelector(".console-levels").addEventListener("click", function (event) {
    var button = event.target.closest("[data-console-level]");
    if (!button) return;
    consoleLevelFilter = button.dataset.consoleLevel || "all";
    updateConsoleFilters();
    renderConsole();
  });

  $("consoleSearchInput").addEventListener("input", renderConsole);
  $("clearConsoleBtn").addEventListener("click", clearConsoleLogs);
  $("consoleRows").addEventListener("click", function (event) {
    var toggle = event.target.closest(".console-stack-toggle[data-console-stack-key]");
    if (toggle) {
      var key = toggle.dataset.consoleStackKey;
      expandedConsoleStacks[key] = !expandedConsoleStacks[key];
      renderConsole();
      return;
    }
    var source = event.target.closest(".console-source-link");
    if (!source) return;
    openConsoleSource(source);
  });

  $("configList").addEventListener("click", function (event) {
    var row = event.target.closest("[data-config-table]");
    if (!row) return;
    showingConfigChanges = false;
    selectedConfigTable = row.dataset.configTable;
    selectedConfigData = null;
    expandedConfigPaths = { "[]": true };
    configVirtualScrollTop = 0;
    renderGameConfig();
  });

  $("configDetail").addEventListener("click", function (event) {
    if (event.target.closest("#saveConfigTemplateBtn")) {
      saveConfigTemplate();
      return;
    }
    if (event.target.closest("#applyConfigTemplateBtn")) {
      applyConfigTemplate();
      return;
    }
    var arrayAction = event.target.closest("[data-config-array-action]");
    if (arrayAction) {
      event.preventDefault();
      event.stopPropagation();
      spliceGameConfigArray(
        parseConfigPath(arrayAction.dataset.configPath),
        Number(arrayAction.dataset.configIndex) || 0,
        arrayAction.dataset.configArrayAction
      );
      return;
    }
    var changeRow = event.target.closest("[data-config-change-id]");
    if (changeRow) {
      var change = configModifiedMap[changeRow.dataset.configChangeId];
      if (!change) {
        var template = selectedConfigTemplate();
        if (template) {
          change = template.changes.find(function (item) {
            return configChangeId(item.table, item.path || []) === changeRow.dataset.configChangeId;
          });
        }
      }
      if (!change) return;
      showingConfigChanges = false;
      selectedConfigTable = change.table;
      selectedConfigData = null;
      expandedConfigPaths = { "[]": true };
      change.path.slice(0, -1).forEach(function (_, index) {
        expandedConfigPaths[configPathKey(change.path.slice(0, index + 1))] = true;
      });
      $("configDataSearchInput").value = change.pathText;
      renderGameConfig();
      return;
    }
    var toggle = event.target.closest(".config-value-toggle[data-config-path]");
    if (toggle) {
      var boolPath = parseConfigPath(toggle.dataset.configPath);
      var nextValue = toggle.dataset.configValue !== "true";
      setGameConfigValue(boolPath, nextValue);
      return;
    }
    var head = event.target.closest(".config-node-head[data-config-path]");
    if (!head) return;
    var key = head.dataset.configPath;
    expandedConfigPaths[key] = !expandedConfigPaths[key];
    renderGameConfig();
  });

  $("configDetail").addEventListener("scroll", function (event) {
    if (event.target && event.target.id === "configVirtualList") {
      renderConfigVirtualRows();
    }
  }, true);

  $("configDetail").addEventListener("change", function (event) {
    var templateSelect = event.target.closest("#configTemplateSelect");
    if (templateSelect) {
      selectedConfigTemplateId = templateSelect.value || null;
      renderConfigChanges();
      return;
    }
    var input = event.target.closest("input[data-config-path]");
    if (!input) return;
    setGameConfigValue(parseConfigPath(input.dataset.configPath), configInputValue(input));
  });

  $("gpuBuckets").addEventListener("click", function (event) {
    var head = event.target.closest("[data-gpu-bucket]");
    if (!head) return;
    var name = head.dataset.gpuBucket;
    expandedGpuBuckets[name] = !expandedGpuBuckets[name];
    renderGpu();
  });

  async function toggleNodeVisible(path, visible) {
    await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "setNodeVisible",
      path: path,
      visible: visible
    }) + ")");
    await collectSnapshot();
    renderNodes();
  }

  async function setSelectedNodeProperty(property, value) {
    if (!selectedNodePath || !property) return;
    await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "setNodeProperty",
      path: selectedNodePath,
      property: property,
      value: value
    }) + ")");
    await collectSnapshot();
    renderNodes();
  }

  async function outputSelectedNodeToConsole() {
    if (!selectedNodePath) return;
    var result = await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "outputNodeToConsole",
      path: selectedNodePath
    }) + ")");
    var response = result.value || result;
    if (response && response.ok) {
      setStatus(response.message || "已输出节点到控制台", false);
    } else {
      setStatus(response && response.message ? response.message : "输出节点到控制台失败", true);
    }
  }

  async function setTimeScale(value) {
    var scale = Number(value);
    if (!Number.isFinite(scale)) scale = 1;
    if (scale > 0) lastNonZeroTimeScale = scale;
    await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "setTimeScale",
      value: scale
    }) + ")");
    await collectSnapshot();
    updateNodeToolbar();
  }

  function collectNodePaths(node, paths) {
    paths = paths || [];
    if (!node) return paths;
    paths.push(node.path);
    (node.children || []).forEach(function (child) {
      collectNodePaths(child, paths);
    });
    return paths;
  }

  async function updateSelectedNodeHighlight() {
    await evalInPage("window.__LayaProfiler && window.__LayaProfiler.command(" + JSON.stringify({
      type: "highlightNode",
      enabled: nodeHighlightEnabled,
      path: selectedNodePath || ""
    }) + ")");
  }

  $("nodeDetail").addEventListener("change", function (event) {
    var input = event.target.closest("[data-node-property]");
    if (!input || input.dataset.nodeBoolean) return;
    setSelectedNodeProperty(input.dataset.nodeProperty, input.value);
  });

  $("nodeDetail").addEventListener("input", function (event) {
    var input = event.target.closest('input[type="range"][data-node-property]');
    if (!input) return;
    var paired = $("nodeDetail").querySelector('input[type="number"][data-node-property="' + input.dataset.nodeProperty + '"]');
    if (paired) paired.value = input.value;
    setSelectedNodeProperty(input.dataset.nodeProperty, input.value);
  });

  $("nodeDetail").addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    var input = event.target.closest("input[data-node-property]");
    if (!input || input.dataset.nodeBoolean) return;
    input.blur();
  });

  $("nodeDetail").addEventListener("click", function (event) {
    var consoleButton = event.target.closest("button[data-node-action='console']");
    if (consoleButton) {
      outputSelectedNodeToConsole();
      return;
    }
    var button = event.target.closest("button[data-node-property][data-node-boolean]");
    if (!button) return;
    setSelectedNodeProperty(button.dataset.nodeProperty, button.dataset.nodeBoolean !== "true");
  });

  $("nodeSearchInput").addEventListener("input", renderNodes);

  $("nodePauseBtn").addEventListener("click", function () {
    var scale = Number($("nodeTimeScaleInput").value);
    if (!Number.isFinite(scale)) scale = 1;
    setTimeScale(scale === 0 ? lastNonZeroTimeScale || 1 : 0);
  });

  $("nodeTimeScaleInput").addEventListener("change", function () {
    setTimeScale($("nodeTimeScaleInput").value);
  });

  $("nodeTimeScaleInput").addEventListener("keydown", function (event) {
    if (event.key === "Enter") $("nodeTimeScaleInput").blur();
  });

  $("refreshNodesBtn").addEventListener("click", collectSnapshot);

  $("expandAllNodesBtn").addEventListener("click", function () {
    expandedNodePaths = {};
    collectNodePaths(snapshot && snapshot.nodes).forEach(function (path) {
      expandedNodePaths[path] = true;
    });
    renderNodes();
  });

  $("collapseAllNodesBtn").addEventListener("click", function () {
    expandedNodePaths = { "0": true };
    renderNodes();
  });

  $("nodeHighlightBtn").addEventListener("click", function () {
    nodeHighlightEnabled = !nodeHighlightEnabled;
    updateSelectedNodeHighlight();
    updateNodeToolbar();
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

  document.querySelectorAll(".sort-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      resourceSort = {
        key: button.dataset.sortKey,
        dir: button.dataset.sortDir
      };
      renderResources();
    });
  });

  $("takeResourceSnapshotBtn").addEventListener("click", createResourceSnapshot);

  $("resourceSnapshotList").addEventListener("click", function (event) {
    var actionButton = event.target.closest("[data-snapshot-action]");
    var item = event.target.closest(".snapshot-item");
    if (!item) return;
    var id = item.dataset.snapshotId;
    var action = actionButton ? actionButton.dataset.snapshotAction : "select";
    if (action === "delete") {
      deleteResourceSnapshot(id);
      return;
    }
    if (action === "toggle-compare") {
      toggleCompareSnapshot(id);
      return;
    }
    if (action === "quick-compare") {
      compareResourceSnapshots(id, actionButton.dataset.compareTargetId);
      return;
    }
    selectedResourceSnapshotId = id;
    resourceCompareResult = null;
    renderResources();
  });

  $("compareResourceSnapshotsBtn").addEventListener("click", compareSelectedResourceSnapshots);

  dockTab("console");
  updateConsoleFilters();
  renderBottomTabs();
  updatePanelVisibility();
  collectSnapshot();
  setInterval(collectSnapshot, 1000);
})();
