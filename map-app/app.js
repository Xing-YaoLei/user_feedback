// 测试地图应用。
// 设计约束（对应演练要求）：
//  - 数据只存在于本脚本闭包（STATION_DATASET 由 generated/stations.js 提供），
//    不挂 window、不提供任何内部读取接口；
//  - 模拟“移动后加载”：每次地图移动，先显示加载态并等待随机延迟，再按视口渲染标记；
//  - 重合测站在最大缩放级别仍保持聚合（禁用 spiderfy），并以红色标记为“无法展开”；
//  - 所有状态（缩放、中心、加载、标记数、聚合数）都以可见 DOM 呈现。
(function () {
  'use strict';

  const CFG = MAP_CONFIG;
  const ALL = STATION_DATASET;
  const center = [
    (CFG.bbox.minLat + CFG.bbox.maxLat) / 2,
    (CFG.bbox.minLng + CFG.bbox.maxLng) / 2,
  ];

  // ---- 离线假瓦片：画经纬度网格，完全不访问外网 ----
  const GridLayer = L.TileLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      const ctx = tile.getContext('2d');
      ctx.fillStyle = '#eef2f6';
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = '#c9d4df';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, 255, 255);
      ctx.beginPath();
      ctx.moveTo(128, 0); ctx.lineTo(128, 256);
      ctx.moveTo(0, 128); ctx.lineTo(256, 128);
      ctx.stroke();
      ctx.fillStyle = '#7b8aa0';
      ctx.font = '11px monospace';
      ctx.fillText(`z${coords.z} x${coords.x} y${coords.y}`, 6, 16);
      return tile;
    },
  });

  const map = L.map('map', {
    center,
    zoom: 10,
    minZoom: 9,
    maxZoom: CFG.maxZoom,
    zoomControl: false,
    zoomSnap: 1,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 120,
    attributionControl: false,
    inertia: false,        // 关闭拖拽惯性，避免机器人分段拖动时越界振荡
    zoomAnimation: false,  // 关闭缩放动画，防止连续操作打断后标记面板 transform 卡死
    fadeAnimation: false,
    markerZoomAnimation: false,
    worldCopyJump: false,
    maxBounds: [
      [CFG.bbox.minLat - 0.5, CFG.bbox.minLng - 0.5],
      [CFG.bbox.maxLat + 0.5, CFG.bbox.maxLng + 0.5],
    ],
    maxBoundsViscosity: 1.0,
  });
  L.control.zoom({ position: 'topright' }).addTo(map);
  new GridLayer('', { tileSize: 256, minZoom: 9, maxZoom: CFG.maxZoom }).addTo(map);

  // 目标区域边界（可见矩形，帮助判断分块边界）
  L.rectangle(
    [
      [CFG.bbox.minLat, CFG.bbox.minLng],
      [CFG.bbox.maxLat, CFG.bbox.maxLng],
    ],
    { color: '#0ea5e9', weight: 2, fill: false, dashArray: '6 4' }
  ).addTo(map);

  // ---- 聚合图层 ----
  const groupIds = new Set(CFG.coincidentGroups.map((g) => g.groupId));
  const clusterLayer = L.markerClusterGroup({
    maxClusterRadius: 55,
    spiderfyOnEveryZoom: false,
    spiderfyOnMaxZoom: false, // 重合点即使到最大级别也保持聚合
    showCoverageOnHover: false,
    animate: false,
    animateAddingMarkers: false,
    disableClusteringAtZoom: CFG.maxZoom + 1, // 永不触发：最大级别仍允许聚合存在
    iconCreateFunction(cluster) {
      const children = cluster.getAllChildMarkers();
      // 所有子标记坐标完全相同（或属于重合组）→ 无法进一步展开
      const onlyCoincident =
        children.length > 1 &&
        children.every((m) => groupIds.has(m.options.station.groupId)) &&
        new Set(children.map((m) => `${m.getLatLng().lat},${m.getLatLng().lng}`)).size === 1;
      const count = cluster.getChildCount();
      let size = 'small';
      if (count >= 50) size = 'large';
      else if (count >= 15) size = 'medium';
      return L.divIcon({
        html: `<div>${count}</div>`,
        className: `marker-cluster marker-cluster-${size}${onlyCoincident ? ' marker-cluster-stuck' : ''}`,
        iconSize: L.point(40, 40),
      });
    },
  });
  map.addLayer(clusterLayer);

  // ---- 单个测站标记 ----
  function buildMarker(station) {
    const marker = L.marker([station.lat, station.lng], {
      station,
      icon: L.divIcon({
        className: '',
        html: `<div class="station-marker status-${station.status}" data-testid="station-marker" data-station-id="${station.id}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    });
    marker.bindPopup(
      `<div class="station-detail" data-testid="station-detail">
         <h3>${station.name}</h3>
         <table>
           <tr><td>稳定编号</td><td class="stable-id" data-testid="detail-id">${station.id}</td></tr>
           <tr><td>类型</td><td>${station.type}</td></tr>
           <tr><td>状态</td><td>${station.status}</td></tr>
           <tr><td>纬度</td><td>${station.lat.toFixed(6)}</td></tr>
           <tr><td>经度</td><td>${station.lng.toFixed(6)}</td></tr>
           <tr><td>海拔(米)</td><td>${station.elevation}</td></tr>
           <tr><td>安装日期</td><td>${station.installDate}</td></tr>
         </table>
       </div>`,
      { closeButton: true, autoPan: true }
    );
    return marker;
  }

  // 标记只构建一次并全部交给 Leaflet/markercluster 管理投影，
  // 之后绝不在移动中 clearLayers/addLayers，避免投影原点失配。
  clusterLayer.addLayers(ALL.map(buildMarker));

  // ---- 模拟“移动后数据加载延迟” ----
  // 真实系统中瓦片/要素会在移动后异步到达。这里用可见遮罩 + HUD 加载态表达该延迟：
  // 移动开始即进入加载态，延迟结束后回到空闲。标记图层本身保持稳定（不重建），
  // 由 Leaflet 负责投影，机器人必须等待“空闲”后再操作。
  const loadingEl = document.querySelector('[data-testid="hud-loading"]');
  const markersEl = document.querySelector('[data-testid="hud-markers"]');
  const clustersEl = document.querySelector('[data-testid="hud-clusters"]');
  const zoomEl = document.querySelector('[data-testid="hud-zoom"]');
  const latEl = document.querySelector('[data-testid="hud-lat"]');
  const lngEl = document.querySelector('[data-testid="hud-lng"]');
  const veilEl = document.querySelector('[data-testid="loading-veil"]');
  let loadToken = 0;
  let loadTimer = null;

  function setLoading(on) {
    loadingEl.textContent = on ? '加载中' : '空闲';
    loadingEl.className = on ? 'loading-yes' : 'loading-no';
    veilEl.classList.toggle('veil-hidden', !on);
  }

  function refreshViewport() {
    const token = ++loadToken;
    setLoading(true);
    if (loadTimer) clearTimeout(loadTimer);
    const delay =
      CFG.loadDelayMs[0] + Math.random() * (CFG.loadDelayMs[1] - CFG.loadDelayMs[0]);
    loadTimer = setTimeout(() => {
      if (token !== loadToken) return; // 连续移动期间的过期计时直接丢弃
      setLoading(false);
      updateHudCounters();
    }, delay);
  }

  function updateHudCounters() {
    const visibleMarkers = document.querySelectorAll('[data-testid="station-marker"]').length;
    const visibleClusters = document.querySelectorAll('.marker-cluster').length;
    markersEl.textContent = String(visibleMarkers);
    clustersEl.textContent = String(visibleClusters);
  }

  function updateHudPosition() {
    const c = map.getCenter();
    zoomEl.textContent = String(map.getZoom());
    latEl.textContent = c.lat.toFixed(6);
    lngEl.textContent = c.lng.toFixed(6);
  }

  // 点击无法展开的聚合 → 给出可见提示（机器人必须把它记为未完成，而不是估算）
  clusterLayer.on('clusterclick', (e) => {
    const children = e.layer.getAllChildMarkers();
    const onlyCoincident =
      children.length > 1 &&
      children.every((m) => groupIds.has(m.options.station.groupId)) &&
      new Set(children.map((m) => `${m.getLatLng().lat},${m.getLatLng().lng}`)).size === 1;
    if (!onlyCoincident || map.getZoom() < CFG.maxZoom) return;
    L.popup({ closeButton: true })
      .setLatLng(e.latlng)
      .setContent(
        `<div class="stuck-toast" data-testid="stuck-notice">
           该聚合包含 <strong>${children.length}</strong> 个坐标完全重合的测站，
           在最大缩放级别仍无法分离，请标记为<strong>未完成</strong>。
         </div>`
      )
      .openOn(map);
  });

  map.on('movestart zoomstart', () => refreshViewport());
  map.on('moveend zoomend', () => {
    updateHudPosition();
    updateHudCounters();
  });
  clusterLayer.on('animationend', updateHudCounters);

  updateHudPosition();
  updateHudCounters();
  refreshViewport();
})();
