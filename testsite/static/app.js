"use strict";

// 三级联动筛选前端。
// 关键行为（爬虫需要应对的真实站点特征）：
//   1. 切换筛选后结果异步刷新，加载期间【保留旧内容】，不立即清空。
//   2. 请求失败时旧内容同样保留，只显示错误横幅 —— 不能把失败误判为空分支。
//   3. 成功响应到达后一次性替换结果、状态与签名（签名即“结果标识”）。
//   4. 空结果渲染显式的空标识元素，而不是简单地不渲染。
//   5. 晚到的旧响应（overtake）仍会渲染，但带的是旧签名 —— 爬虫用签名识别。

const $ = (id) => document.getElementById(id);

const selects = {
  region: $("region-select"),
  institution: $("institution-select"),
  type: $("type-select"),
};
const queryBtn = $("query-btn");
const statusBox = $("status");
const signatureBox = $("signature");
const resultsBox = $("results");

let requestSeq = 0;

async function getJSON(url) {
  const resp = await fetch(url);
  const payload = await resp.json();
  if (!resp.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${resp.status}`);
  }
  return payload;
}

function setStatus(state, text) {
  statusBox.dataset.state = state;
  statusBox.className = state === "idle" ? "" : state;
  statusBox.textContent = text;
}

function fillSelect(select, options, placeholder) {
  select.innerHTML = "";
  const head = new Option(placeholder, "");
  head.disabled = true;
  select.add(head);
  for (const item of options) select.add(new Option(item.label, item.id));
  select.value = "";
  select.disabled = false;
}

function resetSelect(select, placeholder) {
  select.innerHTML = "";
  select.add(new Option(placeholder, ""));
  select.value = "";
  select.disabled = true;
}

function renderResults(payload) {
  const devices = payload.devices;
  signatureBox.dataset.signature = payload.signature;
  signatureBox.textContent = `结果签名：${payload.signature}`;
  if (devices.length === 0) {
    resultsBox.innerHTML =
      '<div class="empty" data-empty="1">当前筛选条件下没有设备（空结果）</div>';
    return;
  }
  let html = '<table data-result-table="1"><thead><tr>' +
    "<th>设备编号</th><th>名称</th><th>型号</th><th>厂商</th></tr></thead><tbody>";
  for (const d of devices) {
    html += `<tr data-device-id="${d.id}">` +
      `<td class="cell-id">${d.id}</td><td class="cell-name">${d.name}</td>` +
      `<td class="cell-model">${d.model}</td><td class="cell-maker">${d.manufacturer}</td></tr>`;
  }
  html += "</tbody></table>";
  resultsBox.innerHTML = html;
}

async function loadRegions() {
  const payload = await getJSON("/api/regions");
  fillSelect(selects.region, payload.regions, "请选择地区");
}

async function onRegionChange() {
  resetSelect(selects.institution, "加载中…");
  resetSelect(selects.type, "请先选择机构");
  queryBtn.disabled = true;
  const region = selects.region.value;
  if (!region) return;
  const payload = await getJSON(`/api/institutions?region=${encodeURIComponent(region)}`);
  fillSelect(selects.institution, payload.institutions, "请选择机构");
}

async function onInstitutionChange() {
  resetSelect(selects.type, "加载中…");
  queryBtn.disabled = true;
  const institution = selects.institution.value;
  if (!institution) return;
  const payload = await getJSON(`/api/types?institution=${encodeURIComponent(institution)}`);
  fillSelect(selects.type, payload.types, "请选择设备类型");
}

function onTypeChange() {
  // 直接读控件自身值：合成事件（无 target.value）与真实交互都能正确处理
  queryBtn.disabled = !selects.type.value;
}

async function runQuery() {
  const region = selects.region.value;
  const institution = selects.institution.value;
  const devType = selects.type.value;
  if (!region || !institution || !devType) return;

  const seq = ++requestSeq;
  // 进入加载态：显式 loading 标识，但【不清空】结果区，旧内容继续可见。
  setStatus("loading", `加载中：${region} / ${institution} / ${devType} …`);
  const expected = `${region}|${institution}|${devType}`;
  try {
    const payload = await getJSON(
      `/api/devices?region=${encodeURIComponent(region)}` +
      `&institution=${encodeURIComponent(institution)}&type=${encodeURIComponent(devType)}`
    );
    // 即使响应晚到也照常渲染（模拟不防竞态的真实前端）；
    // 签名与当前条件是否一致，交给采集方判断。
    void seq;
    renderResults(payload);
    setStatus("ready", `加载完成（请求序号 ${seq}）`);
  } catch (err) {
    // 失败：保留旧内容与旧签名，仅切换错误横幅。
    setStatus("error", `加载失败：${err.message}（可重试；旧结果保留中）`);
  }
}

selects.region.addEventListener("change", onRegionChange);
selects.institution.addEventListener("change", onInstitutionChange);
selects.type.addEventListener("change", onTypeChange);
queryBtn.addEventListener("click", runQuery);

loadRegions()
  .then(() => setStatus("idle", "请依次选择地区 → 机构 → 设备类型，然后点击查询"))
  .catch((err) => setStatus("error", `初始化失败：${err.message}`));
